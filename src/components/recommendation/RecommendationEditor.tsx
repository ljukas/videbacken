import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ClientOnly } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { FieldError } from '~/components/ui/field'
import { Label } from '~/components/ui/label'
import { Skeleton } from '~/components/ui/skeleton'
import { Textarea } from '~/components/ui/textarea'
import { useAppForm } from '~/hooks/form'
import { orpc } from '~/lib/orpc/client'
import { recommendationErrorMessage } from '~/lib/orpc/recommendationErrorMessage'
import type { RecommendationDomainErrorCode } from '~/lib/services/recommendation'
import { m } from '~/paraglide/messages'
import { PhotoUploader } from './PhotoUploader'
import {
  type FormPhoto,
  photosUploading,
  toCreatePhotos,
  toUpdatePhotos,
} from './recommendationFormTypes'
import { TagPicker } from './TagPicker'

// maplibre is heavy + browser-only — keep it out of the SSR bundle.
const LocationPicker = lazy(() => import('./LocationPicker'))

// The create/update procedures expose a wider typed-error union than the domain
// (glue-only INVALID_PATH/FILE_NOT_IN_STORAGE), so narrow to the codes the message
// map actually handles before calling it. The `Record<...DomainErrorCode, true>`
// keeps this set exhaustive — adding a domain code breaks the build until listed.
const RECOMMENDATION_ERROR_CODES: Record<RecommendationDomainErrorCode, true> = {
  NOT_FOUND: true,
  CANNOT_EDIT_OTHERS_RECOMMENDATION: true,
  CANNOT_DELETE_OTHERS_RECOMMENDATION: true,
  NO_PHOTOS: true,
  TOO_MANY_PHOTOS: true,
  DUPLICATE_PHOTOS: true,
  DUPLICATE_TAGS: true,
}
function isRecommendationErrorCode(code: string): code is RecommendationDomainErrorCode {
  return Object.hasOwn(RECOMMENDATION_ERROR_CODES, code)
}

type Initial = {
  title: string
  description: string
  lat: number
  lng: number
  tagIds: string[]
  photos: FormPhoto[]
}

type Props =
  | { mode: 'create'; onDone: (placeId?: string) => void }
  | {
      mode: 'edit'
      recommendationId: string
      initial: Initial
      onDone: (placeId?: string) => void
    }

const schema = z.object({
  title: z
    .string()
    .min(1, { error: () => m.recommendation_validation_title_required() })
    .max(255),
  description: z.string().max(2000),
  location: z
    .object({ lat: z.number(), lng: z.number() })
    .nullable()
    .refine((v) => v !== null, {
      error: () => m.recommendation_validation_location_required(),
    }),
  tagIds: z.array(z.string()),
  // FormPhoto is a UI view-model, not a Zod schema, so validate the array shape
  // with two refines: at least one photo, and no in-flight/failed upload.
  photos: z
    .array(z.any())
    .refine((ps: FormPhoto[]) => ps.length >= 1, {
      error: () => m.recommendation_validation_photos_required(),
    })
    .refine((ps: FormPhoto[]) => !photosUploading(ps), {
      error: () => m.recommendation_photo_uploading(),
    }),
})

export function RecommendationEditor(props: Props) {
  const queryClient = useQueryClient()
  const isEdit = props.mode === 'edit'

  const createMutation = useMutation(orpc.recommendation.create.mutationOptions())
  const updateMutation = useMutation(orpc.recommendation.update.mutationOptions())

  const form = useAppForm({
    defaultValues: isEdit
      ? {
          title: props.initial.title,
          description: props.initial.description,
          location: { lat: props.initial.lat, lng: props.initial.lng } as {
            lat: number
            lng: number
          } | null,
          tagIds: props.initial.tagIds,
          photos: props.initial.photos,
        }
      : {
          title: '',
          description: '',
          location: null as { lat: number; lng: number } | null,
          tagIds: [] as string[],
          photos: [] as FormPhoto[],
        },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const loc = value.location as { lat: number; lng: number }
      try {
        const res = isEdit
          ? await updateMutation.mutateAsync({
              id: props.recommendationId,
              title: value.title,
              description: value.description || undefined,
              lat: loc.lat,
              lng: loc.lng,
              tagIds: value.tagIds,
              photos: toUpdatePhotos(value.photos),
            })
          : await createMutation.mutateAsync({
              title: value.title,
              description: value.description || undefined,
              lat: loc.lat,
              lng: loc.lng,
              tagIds: value.tagIds,
              photos: toCreatePhotos(value.photos),
            })
        await queryClient.invalidateQueries({ queryKey: orpc.recommendation.key() })
        props.onDone(res.id)
      } catch (rawErr) {
        // Stay on the form (don't lose the multi-photo input); map domain codes.
        // `mutateAsync` rejects with the procedure's typed error union, but the
        // catch binding is `unknown`; widen it to the mutations' error type so
        // `isDefinedError` has a union to narrow (create/update share the same
        // recommendation codes, plus glue-only ones the message map ignores).
        const err = rawErr as typeof createMutation.error | typeof updateMutation.error
        const msg =
          isDefinedError(err) && isRecommendationErrorCode(err.code)
            ? recommendationErrorMessage(err.code)
            : m.recommendation_save_error()
        toast.error(msg)
      }
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
      className="flex flex-col gap-6"
    >
      <form.AppField
        name="title"
        children={(field) => <field.TextField label={m.recommendation_field_title()} />}
      />

      <form.AppField
        name="photos"
        children={(field) => (
          <div className="flex flex-col gap-1.5">
            <Label>{m.recommendation_field_photos()}</Label>
            <PhotoUploader
              value={field.state.value}
              onChange={(next) => field.handleChange(next)}
              onExifLocation={(loc) => {
                // Pre-fill location from the first GPS photo only if not already set
                // (don't override a manual placement or an edit's existing location).
                if (form.getFieldValue('location') == null) {
                  form.setFieldValue('location', loc)
                }
              }}
            />
            <FieldError errors={field.state.meta.errors} />
          </div>
        )}
      />

      <form.AppField
        name="location"
        children={(field) => (
          <div className="flex flex-col gap-1.5">
            <Label>{m.recommendation_field_location()}</Label>
            <div className="h-64 overflow-hidden rounded-xl border md:h-80">
              <ClientOnly fallback={<Skeleton className="size-full" />}>
                <Suspense fallback={<Skeleton className="size-full" />}>
                  <LocationPicker
                    value={field.state.value}
                    onChange={(loc) => field.handleChange(loc)}
                  />
                </Suspense>
              </ClientOnly>
            </div>
            <p className="text-muted-foreground text-xs">
              {field.state.value
                ? m.recommendation_location_hint()
                : m.recommendation_location_unset()}
            </p>
            <FieldError errors={field.state.meta.errors} />
          </div>
        )}
      />

      <form.AppField
        name="description"
        children={(field) => (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rec-description">{m.recommendation_field_description()}</Label>
            <Textarea
              id="rec-description"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder={m.recommendation_field_description_placeholder()}
              rows={4}
            />
            <FieldError errors={field.state.meta.errors} />
          </div>
        )}
      />

      <form.AppField
        name="tagIds"
        children={(field) => (
          <div className="flex flex-col gap-1.5">
            <Label>{m.recommendation_field_tags()}</Label>
            <TagPicker value={field.state.value} onChange={(ids) => field.handleChange(ids)} />
          </div>
        )}
      />

      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <form.AppForm>
          <form.CancelButton onClick={() => props.onDone()}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton
            label={isEdit ? m.recommendation_edit_submit() : m.recommendation_create_submit()}
            pendingLabel={m.recommendation_submit_pending()}
          />
        </form.AppForm>
      </div>
    </form>
  )
}
