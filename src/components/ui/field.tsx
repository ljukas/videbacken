import { cva, type VariantProps } from 'class-variance-authority'
import { useMemo } from 'react'
import { Label } from '~/components/ui/label'
import { Separator } from '~/components/ui/separator'
import { cn } from '~/lib/utils'

function FieldSet({ className, ...props }: React.ComponentProps<'fieldset'>) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        // Layout: vertical stack
        'flex flex-col gap-4',
        // Tighter gap when wrapping a checkbox/radio group
        'has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3',
        className,
      )}
      {...props}
    />
  )
}

function FieldLegend({
  className,
  variant = 'legend',
  ...props
}: React.ComponentProps<'legend'> & { variant?: 'legend' | 'label' }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        'mb-1.5 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base',
        className,
      )}
      {...props}
    />
  )
}

function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        // Container-query context for child Fields, plus group hook
        'group/field-group @container/field-group',
        // Layout: vertical stack
        'flex w-full flex-col gap-5',
        // Tighter gap for checkbox groups; nested field-groups
        'data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4',
        className,
      )}
      {...props}
    />
  )
}

const fieldVariants = cva(
  // Base: group hook, flex row by default, invalid state turns destructive
  'group/field flex w-full gap-2 data-[invalid=true]:text-destructive',
  {
    variants: {
      orientation: {
        // Stacked label-over-control; children full-width except visually-hidden labels
        vertical: ['flex-col', '*:w-full [&>.sr-only]:w-auto'],
        // Label beside control on one row
        horizontal: [
          // Direction + alignment
          'flex-row items-center',
          // Let the label grow to fill the row
          '*:data-[slot=field-label]:flex-auto',
          // When a field-content block is present: top-align and nudge the checkbox/radio
          'has-[>[data-slot=field-content]]:items-start',
          'has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
        ],
        // Stacked on narrow groups, switches to horizontal at the field-group @md breakpoint
        responsive: [
          // Direction: column by default, row at @md
          '@md/field-group:flex-row flex-col',
          // Alignment: center children once horizontal
          '@md/field-group:items-center',
          // Width: full when stacked, auto once horizontal; visually-hidden labels stay auto
          '*:w-full @md/field-group:*:w-auto [&>.sr-only]:w-auto',
          // Let the label grow to fill the row once horizontal
          '@md/field-group:*:data-[slot=field-label]:flex-auto',
          // When a field-content block is present (horizontal): top-align and nudge the checkbox/radio
          '@md/field-group:has-[>[data-slot=field-content]]:items-start',
          '@md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
        ],
      },
    },
    defaultVariants: {
      orientation: 'vertical',
    },
  },
)

function Field({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  )
}

function FieldContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-content"
      className={cn('group/field-content flex flex-1 flex-col gap-0.5 leading-snug', className)}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        // Base: group/peer hooks, inline label sizing
        'group/field-label peer/field-label flex w-fit gap-2 leading-snug',
        // Card styling when the label wraps a nested field (e.g. selectable card)
        'has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border *:data-[slot=field]:p-2.5',
        // Checked state highlight (with dark-mode variant)
        'has-data-checked:border-primary/30 has-data-checked:bg-primary/5 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10',
        // Dim when the parent field is disabled
        'group-data-[disabled=true]/field:opacity-50',
        // Card layout: full-width, stacked
        'has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col',
        className,
      )}
      {...props}
    />
  )
}

function FieldTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        'flex w-fit items-center gap-2 font-medium text-sm group-data-[disabled=true]/field:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        // Base muted helper text; balance text inside a horizontal field
        'text-left font-normal text-muted-foreground text-sm leading-normal group-has-data-horizontal/field:text-balance',
        // Tighten gap right after a legend
        '[[data-variant=legend]+&]:-mt-1.5',
        // Spacing tweaks by position in the field
        'nth-last-2:-mt-1 last:mt-0',
        // Inline link styling
        '[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4',
        className,
      )}
      {...props}
    />
  )
}

function FieldSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(
        'relative -my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2',
        className,
      )}
      {...props}
    >
      <Separator className="absolute inset-0 top-1/2" />
      {children && (
        <span
          className="relative mx-auto block w-fit bg-background px-2 text-muted-foreground"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      )}
    </div>
  )
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<'div'> & {
  errors?: Array<{ message?: string } | undefined>
}) {
  const content = useMemo(() => {
    if (children) {
      return children
    }

    if (!errors?.length) {
      return null
    }

    const uniqueErrors = [...new Map(errors.map((error) => [error?.message, error])).values()]

    if (uniqueErrors?.length === 1) {
      return uniqueErrors[0]?.message
    }

    return (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {uniqueErrors.map((error, index) => error?.message && <li key={index}>{error.message}</li>)}
      </ul>
    )
  }, [children, errors])

  if (!content) {
    return null
  }

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn('font-normal text-destructive text-sm', className)}
      {...props}
    >
      {content}
    </div>
  )
}

export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
}
