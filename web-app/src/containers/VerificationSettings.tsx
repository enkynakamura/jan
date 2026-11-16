/**
 * Fork: the settings of the verification of a reply (see `verifyReply` and
 * `verifySeries`): the output cap of the verifier, and how many times a
 * reply is verified at each click.
 */
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { VERIFY_REPETITIONS_MAX } from '@/lib/verifySeries'

/** The caps offered. The first is the one of a new installation. */
export const VERIFY_CAP_CHOICES = [8192, 16384, 32768]

/** The numbers of runs offered. The first is the one of a new installation. */
export const VERIFY_REPETITION_CHOICES = Array.from(
  { length: VERIFY_REPETITIONS_MAX },
  (_, index) => index + 1
)

/** One value among a few: a button each, the one in use pressed. */
function Choices({
  label,
  choices,
  value,
  onChoose,
}: {
  label: string
  choices: number[]
  value: number
  onChoose: (choice: number) => void
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      {choices.map((choice) => (
        <Button
          key={choice}
          size="sm"
          variant={choice === value ? 'default' : 'outline'}
          aria-pressed={choice === value}
          onClick={() => onChoose(choice)}
        >
          {choice.toLocaleString('en-US')}
        </Button>
      ))}
    </div>
  )
}

export function VerificationSettings() {
  const {
    verifyMaxOutputTokens,
    setVerifyMaxOutputTokens,
    verifyRepetitions,
    setVerifyRepetitions,
  } = useGeneralSetting()
  return (
    <Card title="Verification">
      <CardItem
        title="Output cap of the verifier"
        description="How many tokens the model that verifies a reply may write, reasoning included. The engine gives about three quarters of them to the reasoning and then closes it. A higher cap lets the check go further into the reply and takes longer."
        actions={
          <Choices
            label="Output cap of the verifier"
            choices={VERIFY_CAP_CHOICES}
            value={verifyMaxOutputTokens}
            onChoose={setVerifyMaxOutputTokens}
          />
        }
      />
      <CardItem
        title="Repetitions"
        description="How many times a reply is verified at each click, one run after the other. Two runs seldom report the same statements: more runs collect more of them, the mistaken ones included. Every statement reported is marked, and the panel says in how many runs it was reported. The time is multiplied by the number of runs."
        actions={
          <Choices
            label="Repetitions"
            choices={VERIFY_REPETITION_CHOICES}
            value={verifyRepetitions}
            onChoose={setVerifyRepetitions}
          />
        }
      />
    </Card>
  )
}
