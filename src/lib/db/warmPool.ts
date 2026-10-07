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
