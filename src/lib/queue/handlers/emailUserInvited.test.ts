import { expect, test } from 'vitest'
import { handleEmailUserInvitedMessage } from './emailUserInvited'

const META = { messageId: 'test-msg', deliveryCount: 1 }

// The email effect short-circuits to devLog under VITEST, so the handler is a
// pure pass-through here — we assert the contract (resolves, no throw). The
// real SMTP/Resend send is exercised in manual e2e (Mailpit).
test('handleEmailUserInvitedMessage dispatches the invite email without throwing', async () => {
  await expect(
    handleEmailUserInvitedMessage(
      {
        to: 'newbie@test.videbacken.local',
        inviteUrl: 'https://videbacken.example/login',
        locale: 'sv',
      },
      META,
    ),
  ).resolves.toBeUndefined()
})
