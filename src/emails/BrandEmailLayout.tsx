import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from 'react-email'
import type { Locale } from '~/paraglide/runtime'
import { emailTailwindConfig } from './theme'

// The brand sail (public/email-logo.png) is served from the same origin that
// issued the action link — prod, preview, or localhost all resolve correctly,
// with no env lookup. (SVG is stripped by most clients, so the mark is a PNG.)
export const logoSrcFor = (url: string) => `${new URL(url).origin}/email-logo.png`

export interface BrandEmailLayoutProps {
  // Recipient locale, resolved by the caller (emails render outside any request
  // scope — queue jobs, previews, tests).
  locale: Locale
  // Inbox preview text (first element inside <Body>).
  preview: string
  // The action link; its origin sources the logo and it backs the CTA + the
  // plain-text fallback link.
  actionUrl: string
  heading: string
  body: string
  buttonLabel: string
  fallbackText: string
  footer: string
}

/**
 * Shared "quiet nautical" email shell (ADR-0015): brand-wash card, logo
 * wordmark, heading + body, a single CTA button, a fallback link, and a footer.
 * Every transactional template (magic-link, invite, …) is just this layout with
 * its own message strings — so the markup, brand wash, and `logoSrcFor` live in
 * one place. See ADR-0008.
 */
export function BrandEmailLayout({
  locale,
  preview,
  actionUrl,
  heading,
  body,
  buttonLabel,
  fallbackText,
  footer,
}: BrandEmailLayoutProps) {
  return (
    <Tailwind config={emailTailwindConfig}>
      <Html lang={locale}>
        <Head />

        <Body className="m-0 bg-bg p-0 font-sans">
          <Preview>{preview}</Preview>
          <Container className="mx-auto w-full max-w-[600px] px-6 py-12">
            <Section
              className="overflow-hidden rounded-[16px] border border-border border-solid bg-card shadow-card"
              style={{
                // Faint nautical-blue wash at the top, echoing /login's .brand-wash.
                // Outlook ignores backgroundImage and falls back to the white bg.
                backgroundColor: '#FFFFFF',
                backgroundImage:
                  'radial-gradient(120% 80% at 50% -10%, rgba(21,108,221,0.10), rgba(255,255,255,0) 60%)',
              }}
            >
              <Section className="px-10 pt-12 pb-10 text-center">
                <Section className="mb-7">
                  <Img
                    src={logoSrcFor(actionUrl)}
                    alt=""
                    width={48}
                    height={48}
                    className="mx-auto block"
                  />
                  <Text className="m-0 mt-3 font-24 font-sans text-fg">Oceanview</Text>
                </Section>

                <Section className="mx-auto max-w-[420px]">
                  <Heading as="h1" className="m-0 font-40 font-sans text-fg">
                    {heading}
                  </Heading>
                  <Text className="m-0 mt-4 font-14 font-sans text-fg-muted">{body}</Text>
                </Section>

                <Section className="mt-9">
                  <Button
                    href={actionUrl}
                    className="box-border inline-block rounded-[10px] bg-brand px-6 py-3 font-15 font-sans text-brand-fg no-underline"
                  >
                    {buttonLabel}
                  </Button>
                </Section>

                <Section className="mx-auto mt-11 max-w-[420px]">
                  <Hr className="m-0 border-border border-solid border-t" />
                  <Text className="m-0 mt-6 font-13 font-sans text-fg-muted">{fallbackText}</Text>
                  <Link href={actionUrl} className="break-all font-13 font-sans text-brand">
                    {actionUrl}
                  </Link>
                </Section>
              </Section>
            </Section>

            <Section className="px-6 py-8 text-center">
              <Text className="m-0 font-11 font-sans text-fg-muted">{footer}</Text>
            </Section>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  )
}
