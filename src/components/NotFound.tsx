import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { m } from '~/paraglide/messages'

export function NotFound({ children }: { children?: ReactNode }) {
  return (
    <div className="space-y-2 p-2">
      <div className="text-gray-600 dark:text-gray-400">
        {children || <p>{m.notfound_body()}</p>}
      </div>
      <p className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="rounded-sm bg-emerald-500 px-2 py-1 font-black text-sm text-white uppercase"
        >
          {m.common_back()}
        </button>
        <Link
          to="/"
          className="rounded-sm bg-cyan-600 px-2 py-1 font-black text-sm text-white uppercase"
        >
          {m.notfound_home()}
        </Link>
      </p>
    </div>
  )
}
