export const USER_PROMPT_ID_FLOOR = 1_000_000_000_000;

export function isUserPromptId(id: unknown) {
  return Number(id) >= USER_PROMPT_ID_FLOOR;
}
