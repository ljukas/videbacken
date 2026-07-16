# Videbacken

Internal web app for the Videbacken sailboat co-ownership group.

## Stack

- **Framework:** [TanStack Start](https://tanstack.com/start/latest) (RC) — file-based router in `src/routes/`
- **UI:** [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) (planned)
- **Auth:** [Better Auth](https://www.better-auth.com) — magic-link only (planned)
- **Database:** [Neon Postgres](https://neon.tech) via Vercel Marketplace + [Drizzle ORM](https://orm.drizzle.team) (planned)
- **File storage:** [Cloudflare R2](https://developers.cloudflare.com/r2/) (planned)
- **Email:** [Resend](https://resend.com) (planned)
- **Hosting:** [Vercel](https://vercel.com) (Hobby)
- **Package manager:** bun

## Develop

```bash
bun install
cp .env.example .env
# Fill in NEON_API_KEY (create one at https://console.neon.tech/app/settings/api-keys)

bun run db:up        # start Neon Local docker proxy → ephemeral DB branch
bun run db:migrate   # apply pending migrations (no-op until first table)
bun run dev          # http://localhost:14600

bun run db:studio    # browse the DB at https://local.drizzle.studio
bun run db:down      # stop docker; ephemeral branch is auto-deleted
```

`bun run build` produces the Nitro output in `.output/`.

## Documentation

See [CLAUDE.md](./CLAUDE.md) for the full stack rationale, architectural decisions, and conventions.
