import { Pool, type PoolClient, type PoolConfig } from 'pg'

export type WarmPoolConfig = PoolConfig & {
  /** Discard an idle connection released longer ago than this, by the wall clock. */
  maxIdleAgeMillis?: number
  /** Called for each checkout of an idle connection: how long it sat idle, and whether that expired it. */
  onIdleCheckout?: (idleMs: number, expired: boolean) => void
}

type ConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: boolean | Error) => void,
) => void

/**
 * A pg `Pool` whose idle connections expire by wall-clock age at checkout
 * (ADR-0025 §5, roadmap step 8). The pool keeps warm connections across a
 * suspended Fluid instance, and a frozen instance can't answer the pooler's
 * heartbeats, so a connection held through a long suspension is likely dead.
 * `idleTimeoutMillis` can't catch it: timers are frozen during suspension and,
 * after resume, fire only after the request has already checked out.
 *
 * pg-pool's `query()` checks out through `this.connect`, so plain queries and
 * transactions both pass through the check.
 */
export class WarmPool extends Pool {
  readonly #maxIdleAge: number
  readonly #onIdleCheckout: (idleMs: number, expired: boolean) => void
  readonly #releasedAt = new WeakMap<PoolClient, number>()
  #warmUp: 'pending' | 'running' | 'done' = 'pending'

  constructor({
    maxIdleAgeMillis = Number.POSITIVE_INFINITY,
    onIdleCheckout = () => {},
    ...config
  }: WarmPoolConfig = {}) {
    super(config)
    this.#maxIdleAge = maxIdleAgeMillis
    this.#onIdleCheckout = onIdleCheckout
    this.on('release', (_err, client) => this.#releasedAt.set(client, Date.now()))
  }

  connect(): Promise<PoolClient>
  connect(callback: ConnectCallback): void
  connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    const checkout = this.#checkoutFresh()
    if (!callback) return checkout
    checkout.then(
      (client) => callback(undefined, client, client.release),
      (err: Error) => callback(err, undefined, () => {}),
    )
  }

  /**
   * Opens the connections `min` still lacks, all at once, releasing each as it
   * connects (server-latency row 8). Called on an instance's first request, they
   * open while its route modules load, so the first checkouts find them idle
   * instead of each opening one. Resolves with how many it opened.
   *
   * Undefined when there's nothing to do: no `min` (dev, tests), a warm-up
   * already in flight, or one that has succeeded. A failed connect rejects once
   * the others have settled, and the next call tries again.
   */
  warmUp(): Promise<number> | undefined {
    if (this.#warmUp !== 'pending') return undefined
    const missing = (this.options.min ?? 0) - this.totalCount
    if (missing <= 0) {
      this.#warmUp = 'done'
      return undefined
    }
    this.#warmUp = 'running'
    // A checkout takes an idle connection before it opens one, so check those out
    // too. Every connect() starts before any resolves: the rest each open their own.
    const opening = Array.from({ length: missing + this.idleCount }, () =>
      this.connect().then((client) => client.release()),
    )
    return Promise.allSettled(opening).then((results) => {
      const failed = results.find((result) => result.status === 'rejected')
      if (failed) {
        this.#warmUp = 'pending'
        throw failed.reason
      }
      this.#warmUp = 'done'
      return missing
    })
  }

  async #checkoutFresh(): Promise<PoolClient> {
    for (;;) {
      const client = await super.connect()
      const releasedAt = this.#releasedAt.get(client)
      if (releasedAt === undefined) return client
      const idleMs = Date.now() - releasedAt
      const expired = idleMs > this.#maxIdleAge
      this.#onIdleCheckout(idleMs, expired)
      if (!expired) return client
      // Releasing with an error removes the client and ends its connection.
      client.release(new Error('pooled connection idle past its maximum age'))
    }
  }
}
