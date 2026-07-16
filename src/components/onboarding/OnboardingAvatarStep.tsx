import { useSuspenseQuery } from '@tanstack/react-query'
import { ArrowLeftIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { AvatarUpload } from '~/components/user/AvatarUpload'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'

type Props = {
  onNext: () => void
  onSkip: () => void
  onBack: () => void
}

export function OnboardingAvatarStep({ onNext, onSkip, onBack }: Props) {
  // AvatarUpload persists the image itself (mint → upload → confirm); this step
  // only adds the next/skip + back chrome. `me.image` gates the primary "Next"
  // button — disabled until a picture is present; the quiet footer "Skip" is the
  // escape hatch for advancing without one.
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())

  // While AvatarUpload is mid-flow, freeze the nav buttons so advancing/leaving
  // can't drop an in-flight image before its `confirm` lands.
  const [uploading, setUploading] = useState(false)

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-1.5 text-center">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">
          {m.onboarding_avatar_title()}
        </h1>
        <p className="text-balance text-muted-foreground text-sm">
          {m.onboarding_avatar_description()}
        </p>
      </header>

      <div className="flex flex-col gap-5">
        <div className="flex justify-center">
          <AvatarUpload onUploadingChange={setUploading} />
        </div>

        <Button
          type="button"
          size="xl"
          className="w-full font-normal"
          onClick={onNext}
          disabled={!me.image || uploading}
        >
          {uploading ? <Spinner data-icon="inline-start" /> : null}
          {m.onboarding_next()}
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={uploading}>
          <ArrowLeftIcon />
          {m.common_back()}
        </Button>
        <Button type="button" variant="ghost" onClick={onSkip} disabled={uploading}>
          {m.onboarding_skip()}
        </Button>
      </div>
    </div>
  )
}
