# Oceanview

Internal web app for the Oceanview sailboat co-ownership group.

## Stack

- **Framework:** [TanStack Start](https://tanstack.com/start/latest) (RC) — file-based router in `src/routes/`
- **UI:** [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) (planned)
- **Auth:** [Better Auth](https://www.better-auth.com) — magic-link only (planned)
- **Database:** [Neon Postgres](https://neon.tech) via Vercel Marketplace + [Drizzle ORM](https://orm.drizzle.team) (planned)
- **File storage:** [Cloudflare R2](https://developers.cloudflare.com/r2/) (planned)
- **Email:** [Resend](https://resend.com) (planned)
- **Hosting:** [Vercel](https://vercel.com) (Hobby)
- **Package manager:** pnpm

## Develop

```bash
pnpm install
cp .env.example .env
# Fill in NEON_API_KEY (create one at https://console.neon.tech/app/settings/api-keys)

pnpm db:up        # start Neon Local docker proxy → ephemeral DB branch
pnpm db:migrate   # apply pending migrations (no-op until first table)
pnpm dev          # http://localhost:14500

pnpm db:studio    # browse the DB at https://local.drizzle.studio
pnpm db:down      # stop docker; ephemeral branch is auto-deleted
```

`pnpm build` produces the Nitro output in `.output/`.

## Documentation

See [CLAUDE.md](./CLAUDE.md) for the full stack rationale, architectural decisions, and conventions.
