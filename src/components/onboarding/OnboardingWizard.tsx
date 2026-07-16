import { useMutation, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { toast } from 'sonner'
import { LocaleSwitcherInline } from '~/components/LocaleSwitcher'
import { Wordmark } from '~/components/Logo'
import { ModeToggle } from '~/components/ModeToggle'
import { logger } from '~/lib/logger/browser'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { OnboardingAvatarStep } from './OnboardingAvatarStep'
import { OnboardingNameStep } from './OnboardingNameStep'
import { OnboardingPasskeyStep } from './OnboardingPasskeyStep'
import { OnboardingPhoneStep } from './OnboardingPhoneStep'

const route = getRouteApi('/onboarding')

const STEPS = ['name', 'phone', 'avatar', 'passkey'] as const
export type OnboardingStep = (typeof STEPS)[number]

export function OnboardingWizard() {
  const { step } = route.useSearch()
  const navigate = route.useNavigate()
  const queryClient = useQueryClient()
  const completeMutation = useMutation(orpc.user.completeOnboarding.mutationOptions())

  const goTo = (next: OnboardingStep) => navigate({ search: (prev) => ({ ...prev, step: next }) })

  // Final step: stamp onboardedAt, then refetch `me` so the _authenticated
  // loader sees a non-null onboardedAt (the gate reads the same cached query) and
  // lets us into the app without bouncing back here.
  const finish = async () => {
    try {
      await completeMutation.mutateAsync({})
    } catch (error) {
      logger.warn('onboarding complete failed', { error })
      toast.error(m.onboarding_save_error())
      return
    }
    await queryClient.refetchQueries({ queryKey: orpc.user.me.key() })
    await navigate({ to: '/' })
  }

  return (
    <div className="brand-wash relative grid min-h-svh place-items-center p-4">
      <div className="absolute top-4 right-4 flex items-center gap-1">
        <LocaleSwitcherInline />
        <ModeToggle />
      </div>
      <div className="flex w-full max-w-sm flex-col items-center gap-8 tracking-normal">
        <Wordmark />
        <StepDots current={step} />
        {step === 'name' ? (
          <OnboardingNameStep onNext={() => goTo('phone')} />
        ) : step === 'phone' ? (
          <OnboardingPhoneStep
            onNext={() => goTo('avatar')}
            onSkip={() => goTo('avatar')}
            onBack={() => goTo('name')}
          />
        ) : step === 'avatar' ? (
          <OnboardingAvatarStep
            onNext={() => goTo('passkey')}
            onSkip={() => goTo('passkey')}
            onBack={() => goTo('phone')}
          />
        ) : (
          <OnboardingPasskeyStep
            onFinish={finish}
            onBack={() => goTo('avatar')}
            finishing={completeMutation.isPending}
          />
        )}
      </div>
    </div>
  )
}

function StepDots({ current }: { current: OnboardingStep }) {
  return (
    <div
      className="flex items-center gap-2"
      role="status"
      aria-label={m.onboarding_step_progress({
        current: STEPS.indexOf(current) + 1,
        total: STEPS.length,
      })}
    >
      {STEPS.map((s) => (
        <span
          key={s}
          className={cn(
            'size-2 rounded-full transition-colors motion-reduce:transition-none',
            s === current ? 'bg-brand' : 'bg-muted-foreground/30',
          )}
        />
      ))}
    </div>
  )
}
