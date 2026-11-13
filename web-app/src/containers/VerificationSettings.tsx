/**
 * Fork: the settings of the verification of a reply (see `verifyReply`). One
 * for now: the output cap of the verifier.
 */
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

/** The caps offered. The first is the one of a new installation. */
export const VERIFY_CAP_CHOICES = [8192, 16384, 32768]

export function VerificationSettings() {
  const { verifyMaxOutputTokens, setVerifyMaxOutputTokens } =
    useGeneralSetting()
  return (
    <Card title="Verification">
      <CardItem
        title="Output cap of the verifier"
        description="How many tokens the model that verifies a reply may write, reasoning included. The engine gives about three quarters of them to the reasoning and then closes it. A higher cap lets the check go further into the reply and takes longer."
        actions={
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Output cap of the verifier"
          >
            {VERIFY_CAP_CHOICES.map((cap) => (
              <Button
                key={cap}
                size="sm"
                variant={cap === verifyMaxOutputTokens ? 'default' : 'outline'}
                aria-pressed={cap === verifyMaxOutputTokens}
                onClick={() => setVerifyMaxOutputTokens(cap)}
              >
                {cap.toLocaleString('en-US')}
              </Button>
            ))}
          </div>
        }
      />
    </Card>
  )
}
