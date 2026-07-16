import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ImageIcon, ImageOffIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog'
import { BlurhashImage } from '~/components/ui/blurhash-image'
import { Button } from '~/components/ui/button'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '~/components/ui/carousel'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { Skeleton } from '~/components/ui/skeleton'
import { orpc } from '~/lib/orpc/client'
import { optimisticRemove } from '~/lib/orpc/optimistic'
import { m } from '~/paraglide/messages'
import { TagChip } from './TagChip'
import { isTagSlug, type TagSlug } from './tagLabels'

export function RecommendationDetailDialog({
  placeId,
  open,
  onOpenChange,
}: {
  placeId: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const {
    data: place,
    isLoading,
    isError,
  } = useQuery({
    ...orpc.recommendation.get.queryOptions({ input: { id: placeId ?? '' } }),
    enabled: open && placeId !== undefined,
    // Poll while a photo is still transcoding so the carousel swaps in the image
    // without a reload. The worker's `recommendation.changed` event can't cross the
    // process boundary to this tab (ADR-0004); polling is the bridge. Self-terminating
    // — stops once every photo is ready (or terminally failed). Mirrors the orb poll.
    refetchInterval: (q) => (q.state.data?.photos.some((ph) => ph.pending) ? 3000 : false),
  })
  const { data: tags } = useQuery(orpc.tag.list.queryOptions())

  const queryClient = useQueryClient()
  const { data: me } = useQuery(orpc.user.me.queryOptions())
  const canManage = !!place && !!me && (me.role === 'admin' || place.authorId === me.id)

  const deleteMutation = useMutation(
    orpc.recommendation.softDelete.mutationOptions({
      // Optimistic-close: callbacks live here (survive the dialog unmount), the place
      // drops from the map list instantly, and onSettled re-syncs from the server.
      onMutate: (vars) =>
        optimisticRemove(queryClient, orpc.recommendation.list.queryKey(), (p) => p.id === vars.id),
      onError: () => toast.error(m.recommendation_delete_error()),
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.recommendation.key() }),
    }),
  )

  const slugById = new Map((tags ?? []).map((t) => [t.id, t.slug]))
  const placeSlugs = (place?.tagIds ?? [])
    .map((id) => slugById.get(id))
    .filter((slug): slug is TagSlug => slug !== undefined && isTagSlug(slug))

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        {isError ? (
          // A stale/deleted deep-link (?place=<gone>) — surface it instead of an
          // endless skeleton. Read-only slice: no retry, just an honest message.
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{m.recommendation_error_not_found()}</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
        ) : isLoading || !place ? (
          <div className="flex flex-col gap-4">
            {/* Radix requires a Title for a11y even while the place loads. */}
            <ResponsiveDialogHeader className="sr-only">
              <ResponsiveDialogTitle>{m.common_loading()}</ResponsiveDialogTitle>
            </ResponsiveDialogHeader>
            <Skeleton className="aspect-video w-full rounded-lg" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Carousel className="w-full" opts={{ loop: place.photos.length > 1 }}>
              <CarouselContent>
                {place.photos.map((photo) => (
                  <CarouselItem key={photo.id}>
                    <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
                      {/* Three states (the read path nulls url when not ready): a failed
                          transcode shows a "couldn't process" placeholder; a pending one
                          (still HEIC, no url yet) shows a "processing" placeholder; once the
                          worker finishes, the realtime refetch swaps in the image. */}
                      {photo.url ? (
                        <BlurhashImage
                          src={photo.url}
                          blurhash={photo.blurhash}
                          alt={m.recommendation_photo_alt({ title: place.title })}
                          width={800}
                          height={450}
                          className="size-full"
                        />
                      ) : photo.failed ? (
                        <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
                          <ImageOffIcon className="size-8" />
                          <p className="text-sm">{m.recommendation_photo_processing_failed()}</p>
                        </div>
                      ) : (
                        <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
                          <ImageIcon className="size-8 animate-pulse" />
                          <p className="text-sm">{m.recommendation_photo_processing()}</p>
                        </div>
                      )}
                    </div>
                  </CarouselItem>
                ))}
              </CarouselContent>
              {place.photos.length > 1 ? (
                <>
                  <CarouselPrevious />
                  <CarouselNext />
                </>
              ) : null}
            </Carousel>

            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>{place.title}</ResponsiveDialogTitle>
              {place.authorName ? (
                <ResponsiveDialogDescription>
                  {m.recommendation_recommended_by({ name: place.authorName })}
                </ResponsiveDialogDescription>
              ) : null}
            </ResponsiveDialogHeader>

            {place.description ? (
              <p className="whitespace-pre-wrap text-sm">{place.description}</p>
            ) : null}

            {placeSlugs.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {placeSlugs.map((slug) => (
                  <TagChip key={slug} slug={slug} />
                ))}
              </div>
            ) : null}

            {canManage ? (
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button asChild variant="outline" size="sm">
                  <Link to="/recommendations/$id/edit" params={{ id: place.id }}>
                    <PencilIcon />
                    {m.recommendation_edit_action()}
                  </Link>
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="text-destructive">
                      <Trash2Icon />
                      {m.recommendation_delete_action()}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{m.recommendation_delete_confirm_title()}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {m.recommendation_delete_confirm_description()}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          deleteMutation.mutate({ id: place.id })
                          onOpenChange(false) // optimistic close; clears ?place via the route handler
                        }}
                      >
                        {m.recommendation_delete_confirm_action()}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : null}
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
