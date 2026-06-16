import { GraphEvents, StepTypes } from '@librechat/agents';
import type * as t from '~/types';
import type { ElicitationChoice } from '~/mcp/connection';

type ElicitationToolCall = { id?: string; name?: string; type?: string; args?: string };

/**
 * Run-step delta that surfaces an MCP elicitation prompt on the current tool call. Mirrors the
 * OAuth prompt delta (`auth`), carrying an `elicitation` payload the client renders as a
 * confirm/choice prompt and responds to via the elicitation respond endpoint.
 */
export function buildMCPElicitationRunStepDeltaEvent({
  stepId,
  toolCall,
  flowId,
  message,
  choices,
  expiresAt,
}: {
  stepId: string;
  toolCall: ElicitationToolCall;
  flowId: string;
  message: string;
  choices?: ElicitationChoice[];
  expiresAt?: number;
}): t.ServerSentEvent {
  return {
    event: GraphEvents.ON_RUN_STEP_DELTA,
    data: {
      id: stepId,
      delta: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [{ ...toolCall }],
        elicitation: {
          flowId,
          message,
          ...(choices && choices.length > 0 ? { choices } : {}),
          ...(expiresAt ? { expires_at: expiresAt } : {}),
        },
      },
    },
  };
}

/** Clears the elicitation prompt from the tool call after the user responds. */
export function buildMCPElicitationEndDeltaEvent({
  stepId,
  toolCall,
}: {
  stepId: string;
  toolCall: ElicitationToolCall;
}): t.ServerSentEvent {
  return {
    event: GraphEvents.ON_RUN_STEP_DELTA,
    data: {
      id: stepId,
      delta: {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [{ ...toolCall }],
      },
    },
  };
}
