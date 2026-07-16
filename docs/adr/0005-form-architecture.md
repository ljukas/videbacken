# ADR 0005 — Form Architecture (TanStack Form composition + shadcn integration)

- **Status**: Accepted
- **Date**: 2026-05-21
- **Deciders**: Lukas
- **Decision in one line**: Every form uses `useAppForm` from `~/hooks/form`; fields render via `<form.AppField>` + pre-bound `<field.TextField>` / `<field.SelectField>`; submit gates via `<form.AppForm>` + `<form.SubmitButton>`. Field errors → `<FieldError>`, async/API errors → `sonner` toasts.

---

## Context

At decision time (May 2026 baseline), Oceanview had three forms (`LoginFormCard`, `RenamePasskeyForm`, `UserForm`), each following the inline `<form.Field>` + render-prop pattern. The pattern worked, but the cost per field was ~16 lines of boilerplate:

```tsx
<form.Field name="email" children={(field) => {
  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid
  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={field.name}>E-post</FieldLabel>
      <Input
        id={field.name}
        name={field.name}
        type="email"
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        aria-invalid={isInvalid}
        disabled={form.state.isSubmitting}
      />
      {isInvalid && <FieldError errors={field.state.meta.errors} />}
    </Field>
  )
}} />
```

`UserForm` repeated this **four times** (one per field). The `<form.Subscribe>` submit-button block was duplicated three times across the three forms. The duplication wasn't deeply harmful then, but adding a 4th form — file library upload metadata, contact details, boat-week assignments — would copy-paste 60+ lines of glue per form. (The bet paid off: as of 2026-06-10 the pattern carries **12** `useAppForm` consumers — see the form inventory in the 2026-06-10 addendum.)

TanStack Form v1 ships `createFormHook` + `useFieldContext` specifically to consolidate this pattern: a tailored `useAppForm` hook with pre-registered, context-bound field components. The composition guide also gives a file layout and a context-based bridge that the shadcn `<Field>` primitives slot into cleanly. Capturing the pattern in an ADR makes it the canonical way to add forms, and migrating the three existing forms proves the pattern carries the real cases.

---

## Decision (TL;DR)

**Adopt `createFormHook` + bound field components.** The public API surface for every form file is exactly three imports:

```ts
import { useAppForm } from '~/hooks/form'
```

…and three concepts at the JSX level:

- **`useAppForm({ defaultValues, validators, onSubmit })`** — same shape as `useForm`; the only difference is what comes back.
- **`<form.AppField name="..." children={(field) => <field.TextField label="..." />} />`** — fields render via bound components accessible on `field.<Name>`.
- **`<form.AppForm>` + `<form.SubmitButton label="..." />`** — submit button is itself a bound form component; submit gating is hidden.

Field errors go to `<FieldError>` (rendered by the bound field component). Async / API / mutation errors go to `sonner` toasts inside the procedure's `onError` callback. **The two channels do not mix.**

This is a **deep module** in the architecture-skill sense: the public interface is small (`useAppForm` + a handful of bound components), the implementation hides the `isInvalid` derivation, the `id`/`htmlFor` linking, the `aria-invalid` wiring, the `field.state.value` / `field.handleChange` / `field.handleBlur` plumbing, and the `form.Subscribe` re-render gating. Two-line callsites replace 16-line blocks.

---

## Alternatives considered

### A. Status quo — inline `<form.Field>` everywhere
- ➕ Reads top-to-bottom; the wiring is visible at the call site.
- ➖ Same wiring repeated per field. The accessibility attributes (`aria-invalid`, `id`, `htmlFor`) are a footgun if a developer copies a field and forgets one.
- ➖ The "should we always render `<FieldError>` or guard with `isInvalid`?" question gets answered N times instead of once.
- **Verdict**: works for 3 forms × ~1.5 fields each. Fails on the next form.

### B. shadcn `<FormField>` wrapper without `createFormHook`
- ➕ Slight reduction in nesting.
- ➖ Still requires the consumer to derive `isInvalid` and pass it through; `useFieldContext` is what lets the wrapper read everything itself.
- ➖ shadcn doesn't actually ship a context-bound field — its TanStack Form integration guide just composes `form.Field` + shadcn primitives, exactly what we do today.
- **Verdict**: solves the wrong half of the problem.

### C. Server-fn-driven forms via `createServerValidate`
- ➕ Forms work without JavaScript (progressive enhancement). Server-side validation errors merge into form state via `useTransform` + `mergeForm`.
- ➖ **Conflicts with the existing data layer** (decided 2026-05-15): mutations go through oRPC + TanStack Query. Adopting `serverValidate` would create a parallel mutation path purely for forms — duplicating an architecture seam.
- ➖ Oceanview is an internal admin tool for 10–20 users where JS is always present. Progressive enhancement isn't a value here.
- **Verdict**: don't. Documented as a future door (see "Revisit triggers").

### D. react-hook-form
- ➕ Mature; large ecosystem.
- ➖ Already on TanStack Form; switching would replace a working library to solve a composition problem TanStack v1 already solves.
- ➖ Loses the typed `name=""` autocomplete inferred from `defaultValues`.
- **Verdict**: don't.

### E. `formOptions` + `withForm` (compose the whole form)
- ➕ Shares form shape across files (e.g. one `formOptions` import for both `CreateUserForm` and `EditUserForm`).
- ➖ Today's `UserForm` already extracts the shape via props; `formOptions` would add indirection without consolidating anything genuinely shared.
- **Verdict**: mentioned in the ADR as available; not adopted in this migration. Revisit if a form shape needs to be shared across **files** (currently none).
- **Superseded 2026-06-10**: the cross-file case arrived (`CreateUserDialog` + `EditUserDialog`) and was solved with `withFieldGroup`, which shares the bound *fields* — not just the options object. `formOptions` remains unused. See the 2026-06-10 addendum.

---

## Architecture

### Two new namespaces

```
src/
  hooks/
    form.ts                       createFormHookContexts() + createFormHook({...})
                                  exports: useAppForm, withForm, withFieldGroup,
                                  useFieldContext, useFormContext
  components/
    form/                         bound field + form components
      TextField.tsx               text/email/tel/password/number inputs (+ suffix input group)
      SelectField.tsx             single-select dropdown
      SubmitButton.tsx            submit-gated button with Spinner
      CancelButton.tsx            submit-aware cancel/close button (added 2026-06-10)
      PhoneField.tsx              phone input (added post-migration)
      ToggleField.tsx             segmented toggle / switch (added post-migration)
      DateField.tsx               date picker; local useState for popover open-state only
      UserSelectField.tsx         user picker (added post-migration)
```

> **Added 2026-06-04.** The initial migration shipped three bound components (`TextField`, `SelectField`, `SubmitButton`); the inventory has since grown by four — `PhoneField`, `ToggleField`, `DateField`, `UserSelectField` — all registered in `src/hooks/form.ts` and following the same context-bound pattern. This is exactly the "add a new bound component to `src/components/form/`" path the ADR prescribes (see *How to add a form*), not a deviation. Note `DateField` keeps a local `useState` for popover open/closed — that's **UI** state, not field value, so the "never `useState` for field values" rule is intact.

> **Added 2026-06-10.** Four pattern updates, verified against `src/hooks/form.ts` and all consumers.
>
> **Bound `<form.CancelButton>` (8th bound component, `src/components/form/CancelButton.tsx`).** `form.state.isSubmitting` read directly in render is **not reactive** — TanStack Form only re-renders through `Subscribe`/`useStore` — so the hand-written `<Button disabled={form.state.isSubmitting}>` cancel buttons the dialogs used to carry never actually disabled during submit. The bound component subscribes via `form.Subscribe` and is registered in `formComponents` alongside `SubmitButton`. **Rule**: cancel/close actions in a form go through `<form.CancelButton>` inside `<form.AppForm>`. It accepts `Button` props (`variant` defaults to `outline`); icon-only usage passes the icon as children (see `PasskeyRow`'s ghost `XIcon` cancel).
>
> **`withFieldGroup` is the sanctioned cross-file sharing mechanism.** The case Alternative E anticipated arrived: `CreateUserDialog` and `EditUserDialog` need the same four fields. `src/components/user/UserFormFields.tsx` packages them as a `withFieldGroup` component, exported alongside `userFieldsSchema` and `userFieldsDefaults`; both dialogs render `<UserFormFields form={form} fields={userFieldsMap} />`. This supersedes the unused `formOptions` recommendation (Alternative E, revisit trigger 1).
>
> **Raw `form.Subscribe` is sanctioned at three sites** (the original ADR allowed one): the `SubmitButton`/`CancelButton` internals, the icon save button in `RenamePasskeyForm` (`PasskeyRow` — the original icon-button exception), and **conditional field display** — `AssignShareDialog` switches whole-vs-split fields on `selector={(s) => s.values.mode}`. Conditional field display is the second caller-level exception; per the extraction rule, a recurrence of either shape is the signal to extract a bound component.
>
> **Convention — numeric inputs** (season dialogs): numeric fields stay **string-typed in form state** (`TextField` is `useFieldContext<string>`, rendered with `type="number"`), are validated as string shapes (regex + `refine`), and are coerced with `Number(...)` in `onSubmit` before calling the mutation. Don't add a `NumberField` for this.
>
> **Scope of the no-`useState` rule**: it applies to submit-bearing forms — `DocumentSearch`'s cmdk palette keeps its query in `useState` and is fine, because a filter input with no submit/validation lifecycle isn't a form field.
>
> **Form inventory as of 2026-06-10** — 12 `useAppForm` consumers: login (`LoginFormCard`), passkey rename (`PasskeyRow`), user create/edit (`CreateUserDialog`/`EditUserDialog`), season create/edit (`CreateSeasonDialog`/`EditSeasonDialog`), share assign/unassign (`AssignShareDialog`/`UnassignShareDialog`), folder create/rename (`CreateFolderDialog`/`RenameFolderDialog`), document rename (`RenameDocumentDialog`), and move (`MoveDialog`).

The plural `components/form/` matches the project's existing entity-folder convention (`user/`, `passkey/`) — the form layer is the entity, the bound components are its surface. The hook lives in `src/hooks/` per project convention; the TanStack-recommended `useAppForm` name is preserved.

### `src/hooks/form.ts` — the entrypoint

```ts
import { createFormHook, createFormHookContexts } from '@tanstack/react-form'
// … one import per bound component from ~/components/form/

export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts()

export const { useAppForm, withForm, withFieldGroup } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField, SelectField, PhoneField, ToggleField, DateField, UserSelectField },
  formComponents: { SubmitButton, CancelButton },
})
```

The circular import (`form.ts` → `TextField` → `form.ts` for `useFieldContext`) resolves cleanly under ESM because `useFieldContext` is only called inside component bodies, not at module-eval time. The same pattern is documented in the TanStack composition guide.

### Bound field components

Each bound component:

1. Calls `useFieldContext<T>()` to access the field's `FieldApi`.
2. Calls `useStore(field.form.store, (s) => s.isSubmitting)` to reactively read form-level `isSubmitting` for `disabled` wiring.
3. Derives `isInvalid` once.
4. Renders a shadcn `<Field data-invalid={isInvalid}>` wrapper with all accessibility attributes (`id={field.name}`, `htmlFor={field.name}`, `aria-invalid={isInvalid}`) pre-wired.
5. Always renders `<FieldError errors={field.state.meta.errors} />`, which returns null on empty — no `isInvalid` guard needed at the consumer.

#### `TextField` interface

```ts
type Props = {
  label: string
  description?: string                          // → <FieldDescription>
  type?: ComponentProps<typeof Input>['type']   // default 'text'; season dialogs use 'number'
  autoComplete?: string
  placeholder?: string
  autoFocus?: boolean
  inputClassName?: string                       // for inline edits with custom heights
  srOnlyLabel?: boolean                         // visually hidden label (inline edits)
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>  // Escape-to-cancel, etc.
  suffix?: string                               // trailing locked text (e.g. file extension) → InputGroup
}
```

`useFieldContext<string>()`. All input-shaped fields (email, tel, password, url, number) share this component — they're variations on `<Input type="...">`. The value stays `string` in form state even for `type="number"` (see the numeric convention in the 2026-06-10 addendum). When `suffix` is set, the field renders as a shadcn `<InputGroup>` with the suffix pinned to the trailing edge (used by `RenameDocumentDialog` for the locked file extension).

#### `SelectField` interface

```ts
type Props = {
  label: string
  description?: string
  placeholder?: string
  options: ReadonlyArray<{ value: string; label: string }>
}
```

`useFieldContext<string>()`. Renders the `<Select>` / `<SelectTrigger>` / `<SelectContent>` / `<SelectItem>` cascade. `id={field.name}` goes on `<SelectTrigger>` so the `<FieldLabel htmlFor={field.name}>` links to the right element.

#### `SubmitButton` interface

```ts
type Props = {
  label: string
  pendingLabel?: string
  className?: string
  variant?: ComponentProps<typeof Button>['variant']
}
```

Calls `useFormContext()`, then subscribes via `form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting]}`. Renders `<Spinner data-icon="inline-start" />` + label, disables on `!canSubmit || isSubmitting`. Lives inside `<form.AppForm>` — that wrapper supplies the form context.

### Composition example — the whole pattern in 25 lines

```tsx
import { useForm as _ } from '@tanstack/react-form'  // (illustrative — don't import)
import { useAppForm } from '~/hooks/form'

const schema = z.object({ email: z.email() })

export function MagicLinkForm({ onSent }: { onSent: (email: string) => void }) {
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.signIn.magicLink({ email: value.email })
      if (error) toast.error(error.message ?? 'Kunde inte skicka inloggningslänken')
      else onSent(value.email)
    },
  })
  return (
    <form onSubmit={(e) => { e.preventDefault(); form.handleSubmit() }}>
      <FieldGroup>
        <form.AppField
          name="email"
          children={(field) => (
            <field.TextField label="E-post" type="email" autoComplete="username webauthn" />
          )}
        />
      </FieldGroup>
      <form.AppForm>
        <form.SubmitButton label="Skicka inloggningslänk" pendingLabel="Skickar…" />
      </form.AppForm>
    </form>
  )
}
```

Everything that varies per form is visible; everything that's invariant is hidden.

### Two-channel error policy (unchanged from existing convention)

- **Field-level errors** (Zod validation, length, format) → rendered by the bound field via `<FieldError>`. The component is responsible; the consumer never imports `FieldError` directly.
- **Async / API / mutation errors** → `toast.error(...)` from `sonner`, invoked in the procedure's `onError` callback (`mutationOptions({ onError: (err) => toast.error(err.message) })`).
- **Do not cross-wire**. A failed mutation shouldn't surface as a `FieldError`; a field that fails Zod shouldn't pop a toast. Field errors are contextual to the input; async errors are contextual to the operation.

### Zod locale (unchanged)

`src/lib/zodLocale.ts` calls `z.config(z.locales.sv())` once at module load (imported from `src/router.tsx`). Every Zod schema gets Swedish default messages without per-field overrides. Override per-field only when the locale default is wrong for the specific case (rare).

### Accessibility wiring (already correct; this ADR locks it in)

- `aria-invalid={isInvalid}` on the input/select trigger.
- `data-invalid={isInvalid}` on the `<Field>` wrapper — drives shadcn's CSS variants (the `data-[invalid=true]:text-destructive` rule in `fieldVariants`).
- `id={field.name}` on the input/trigger; `htmlFor={field.name}` on the label.
- `<FieldLabel className="sr-only">` for inline edits (e.g. rename passkey) where the visible label is the surrounding context.
- `<FieldDescription>` is available via the optional `description` prop for helper text; no aria linking required because the description is rendered inside the `<Field>` group.

### SSR posture — and the door we leave open

TanStack Start ships `createServerValidate` + `createServerFn` + `useTransform`/`mergeForm` for forms that submit without JavaScript and surface server-side validation errors via the response merged into form state. **We don't adopt this.** Reasons:

- **Conflicts with the data layer** (decided 2026-05-15, ADR-0001): mutations are oRPC + TanStack Query. A parallel server-fn path purely for forms duplicates the mutation seam.
- **Progressive enhancement isn't a value** at this scale (10–20 users, JS always enabled).
- **Existing oRPC procedures already do server-side validation** via `.input(zodSchema)`; failures surface as `ORPCError` mapped from `<Entity>DomainError` (see ADR-0002). The validation story is complete on the server.

**Revisit if** progressive enhancement becomes a real requirement (e.g. the app gains a public-facing form that must work over flaky 3G with JS disabled), at which point `createServerValidate` slots in behind the existing `useAppForm` API — `formOptions` would let us share the schema between client and a server fn.

### The icon-button exception

`RenamePasskeyForm` in `PasskeyRow.tsx` has a save button that's an icon-only `<Button variant="ghost" size="icon-sm">` with a custom `aria-label`. The bound `<form.SubmitButton>` renders a labelled button — wrong shape for this caller. **Drop down to raw `<form.Subscribe>` for this one button** rather than inventing an `IconSubmitButton` bound component for a single caller. Document the exception inline.

This is the general rule: **when bound components don't fit, drop to the raw `@tanstack/react-form` API for that specific element.** Don't multiply bound components for one-off shapes. If the same exception recurs in a second place, that's the signal to extract it. (A second *kind* of caller-level exception — conditional field display — was sanctioned 2026-06-10; see the addendum under *Two new namespaces*.)

### Why this is a deep module (in the skill's terms)

- **Interface**: `useAppForm` + the bound components registered in `src/hooks/form.ts` — currently 8 (six `fieldComponents` + `SubmitButton`/`CancelButton` in `formComponents`). Small enough to fit on one screen.
- **Implementation**: hides the `isInvalid` derivation, `id`/`htmlFor`/`aria-invalid` wiring, `field.handleBlur`/`handleChange` plumbing, `form.state.isSubmitting` reactive subscription, `<FieldError>` empty-state handling, and `form.Subscribe` re-render gating.
- **Test surface = the interface**: bound components are React components, testable with React Testing Library; the consumer's form behaves like any normal form (submit, mutate, toast).
- **Two real consumers from day one** (`LoginFormCard`, `RenamePasskeyForm`, `UserForm` — three actually) — the seam is real, not hypothetical.

---

## Verification

A reader can confirm the architecture is being followed without running anything:

- **No raw `@tanstack/react-form` imports in app code.** `grep -rn "from '@tanstack/react-form'" src/` should match only `src/hooks/form.ts` and `src/components/form/*` (the bound components, which import `useStore` directly for reactive form subscription). Anything else is a violation.
- **No raw `<form.Field>` in app code.** `grep -rn "form\.Field" src/` outside the hook file should match zero hits. The user-facing API is `<form.AppField>`.
- **No raw `useForm` import.** `grep -rn "import.*useForm[ ,}]" src/` should match zero hits outside `~/hooks/form.ts` (which uses `useAppForm` only).
- **No `isInvalid` derivation in form callsites.** `grep -rn "isInvalid" src/components/` should match only inside `src/components/form/*` (the bound components own this).
- **`<form.Subscribe>` is used only at the documented sanctioned sites.** `grep -rn "form\.Subscribe\|form\.AppForm" src/` — `Subscribe` appears in the bound `SubmitButton`/`CancelButton` internals plus exactly two caller-level exceptions: the icon save button in `RenamePasskeyForm` (`PasskeyRow`) and conditional field display in `AssignShareDialog` (see the 2026-06-10 addendum); `AppForm` appears wherever a submit/cancel button is rendered.

Manual smoke tests after a migration:

1. **`/login`** — type a bad email, blur, submit; see Swedish Zod error from `<FieldError>`. Type a valid email, submit; see "Skickar…" spinner, magic-link prints in `/tmp/oceanview-dev.log` (devLog adapter, ADR-0001).
2. **`/account`** *(was `/konto`)* — click pencil on a passkey, type a new name, click save; name updates. Press Escape mid-edit; cancels. Try to save an empty name; field error appears.
3. **`/admin/users`** — open "Ny användare" (`CreateUserDialog`), fill all four fields including the segmented role toggle (`ToggleField`), save; toast + dialog close + list refresh. Open "Redigera" on an existing user (`EditUserDialog`), change a field, save; same. Try to save with an invalid email; field error appears.

---

## Critical files

**New (created by the migration)**:
- `src/hooks/form.ts` — `useAppForm` + bound component registration.
- `src/components/form/TextField.tsx`
- `src/components/form/SelectField.tsx`
- `src/components/form/SubmitButton.tsx`

**Modified (migrated to the new shape)**:
- `src/components/login/LoginFormCard.tsx`
- `src/components/passkey/PasskeyRow.tsx` (`RenamePasskeyForm` only)
- `src/components/user/CreateUserDialog.tsx`, `EditUserDialog.tsx`, `UserFormFields.tsx` (the migration touched a combined `UserFormDialog.tsx`, since split into these three; shared fields live in `UserFormFields.tsx` via `withFieldGroup` — see the 2026-06-10 addendum)

**Unchanged** (this ADR doesn't touch these):
- `src/components/user/DeleteUserDialog.tsx`, `RestoreUserDialog.tsx`, `src/components/passkey/DeletePasskeyDialog.tsx` — all `<AlertDialog>`s with no fields.

---

## Adding a form (concrete recipe)

1. **Define a Zod schema** for the fields. The default error messages are Swedish via `~/lib/zodLocale` — override per-field only when the locale default doesn't fit.
2. **`useAppForm`**:
   ```ts
   const form = useAppForm({
     defaultValues: { /* every field, typed */ },
     validators: { onSubmit: schema },
     onSubmit: async ({ value }) => { /* call mutation, toast errors */ },
   })
   ```
3. **Render** in a `<form onSubmit={(e) => { e.preventDefault(); form.handleSubmit() }}>` wrapper.
4. **Each field** is one `<form.AppField name="..." children={(field) => <field.TextField label="..." />}` (or `<field.SelectField label="..." options={[...]}>`).
5. **Submit gating** is `<form.AppForm><form.SubmitButton label="..." pendingLabel="..." /></form.AppForm>`. Cancel/close actions in the same form go through `<form.CancelButton>` inside the same `<form.AppForm>` (see the 2026-06-10 addendum).
6. **Mutation errors** go to `toast.error(...)` in the mutation's `onError`; on success, `toast.success(...)` + invalidate the query keys + close any open dialog.
7. **Test by hand** in `pnpm dev:log`: bad input → field error in Swedish; good input → success path.

If you need a UI primitive the bound components don't expose (a textarea, a multi-select, a date picker), either (a) add a new bound component to `src/components/form/`, or (b) drop down to raw `<form.AppField>` + the primitive for a one-off. Don't invent a one-off bound component for a single caller.

---

## Consequences

**Positive**:
- Form callsites shrink ~60%: a 4-field UserForm goes from ~150 LOC to ~70 LOC; LoginFormCard from ~97 → ~60; RenamePasskeyForm from ~80 → ~50.
- Accessibility attributes (`aria-invalid`, `id`, `htmlFor`) are wired once inside the bound components — no copy-paste-and-forget risk.
- The "validate on submit, not onChange" decision is invisible at the call site; field error rendering is invisible at the call site; the `form.Subscribe` re-render boundary for the submit button is invisible at the call site.
- Adding a 4th form is fast: schema + `useAppForm` + `<field.TextField>` per field + `<form.SubmitButton>`. The cost matches the actual variation.
- The seam is in place for cross-file shape sharing (realized 2026-06-10 via `withFieldGroup`) and server validation (`serverValidate`) if the latter becomes a real need.

**Negative**:
- One indirection. The reader of `LoginFormCard.tsx` has to know that `<field.TextField>` is defined in `src/components/form/TextField.tsx` and registered in `src/hooks/form.ts`. The first-hop is one click; the second is one file open. Documented here.
- Type-safety regression risk on `useFieldContext<T>()`: the type parameter is opaque at runtime — passing `string` for a field whose schema is `'user' | 'admin'` works because the runtime values are strings, but a stricter T would catch the consumer's `as` cast. Mitigation: each bound field uses one specific T (`TextField` → `string`, `SelectField` → `string`, `DateField` → `Date`); the more common bug (misspelling the field `name`) is caught by TypeScript via inference from `defaultValues`.
- The caller-level `<form.Subscribe>` exceptions (icon save button in `RenamePasskeyForm`, conditional field display in `AssignShareDialog` — see the 2026-06-10 addendum) mean the migration isn't 100%. Treated as a feature: don't multiply bound components for single-use shapes.

**Revisit triggers** — re-open this ADR if any of these change:
- ~~A form shape needs to be shared across files (e.g. CreateUserForm + a parallel BulkCreateForm both want the same field set). At that point, adopt `formOptions` and document it here.~~ **Resolved 2026-06-10**: the case arrived (`CreateUserDialog` + `EditUserDialog`) and `withFieldGroup` was adopted instead of `formOptions` — see the 2026-06-10 addendum.
- The icon-button shape recurs in a second form. Extract `IconSubmitButton` as a bound `formComponent`.
- Progressive enhancement becomes a real requirement. Adopt `createServerValidate` + `useTransform` + `mergeForm` per the TanStack Start SSR guide; the existing `useAppForm` API survives, only the submit path changes.
- A primitive emerges that the registered bound components can't express (textarea, checkbox group, radio). Add the bound component to `src/components/form/`; update the `fieldComponents` registration.
- TanStack Form ships a v2 that changes the `createFormHook` API. Re-evaluate at that point.
