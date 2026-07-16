import type * as React from 'react'
import { createContext, useContext } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Sheet, SheetContent } from '~/components/ui/sheet'
import { useIsMobile } from '~/hooks/useMobile'
import { cn } from '~/lib/utils'

// Responsive overlay for small CRUD forms (ADR-0013): a centered `Dialog` on
// desktop, a bottom `Sheet` on mobile. Both shadcn primitives are radix Dialog
// under the hood and share Title/Description semantics, so only the Root and the
// Content differ — Header/Footer/Title/Description are reused from `dialog.tsx`,
// giving an identical look across breakpoints. Call sites swap `Dialog*` →
// `ResponsiveDialog*` with no other changes (same `open`/`onOpenChange`).
//
// SSR: `useIsMobile()` is false until hydration, so a deep-linked-open overlay
// renders as a Dialog for one frame then swaps to the Sheet on mobile. Overlays
// are normally closed at first paint, so this is a non-issue in practice.

const ResponsiveDialogContext = createContext(false)

function ResponsiveDialog({ ...props }: React.ComponentProps<typeof Dialog>) {
  const isMobile = useIsMobile()
  const Root = isMobile ? Sheet : Dialog
  return (
    <ResponsiveDialogContext.Provider value={isMobile}>
      <Root {...props} />
    </ResponsiveDialogContext.Provider>
  )
}

function ResponsiveDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  const isMobile = useContext(ResponsiveDialogContext)
  if (isMobile) {
    return (
      <SheetContent
        side="bottom"
        className={cn(
          // `className` comes first so the trailing `max-w-none sm:max-w-none`
          // wins over any desktop `sm:max-w-*` a caller passes — otherwise the
          // bottom sheet renders narrow + left-pinned at 640–767px. The rest
          // mirrors the Dialog content box (padding + gap) so the reused
          // Header/Footer line up; round only the top, cap height + scroll.
          className,
          'max-h-[90svh] max-w-none gap-4 overflow-y-auto rounded-t-xl p-4 sm:max-w-none',
        )}
        {...props}
      >
        {children}
      </SheetContent>
    )
  }
  return (
    <DialogContent className={className} {...props}>
      {children}
    </DialogContent>
  )
}

// Desktop keeps the Dialog footer (stacked on the narrowest widths, right-aligned
// row from `sm:` up). On the mobile bottom sheet the actions become a single
// finger-friendly row of equal-width, taller (44px) buttons — easier to hit by
// thumb than a vertical stack, and there's always room across the sheet's width.
function ResponsiveDialogFooter({
  className,
  ...props
}: React.ComponentProps<typeof DialogFooter>) {
  const isMobile = useContext(ResponsiveDialogContext)
  return (
    <DialogFooter
      className={cn(isMobile && 'flex-row [&>button]:h-11 [&>button]:flex-1', className)}
      {...props}
    />
  )
}

export {
  DialogDescription as ResponsiveDialogDescription,
  // Reused verbatim — identical in both containers.
  DialogHeader as ResponsiveDialogHeader,
  DialogTitle as ResponsiveDialogTitle,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
}
