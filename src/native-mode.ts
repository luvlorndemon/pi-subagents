/** The fork's package entry enables native sessions; the upstream entry stays
 * available for upstream regression tests and makes future merges smaller. */
let enabled = false;
let delegation = false;
export const NATIVE_SESSION_TYPE = "pi";
export function isNativeSessionMode(): boolean { return enabled; }
export function setNativeSessionMode(value: boolean): void { enabled = value; }
export function nativeDelegationEnabled(): boolean { return delegation; }
export function setNativeDelegation(value: boolean): void { delegation = value; }

export function omitPersonaParameter(schema: { properties?: Record<string, unknown>; required?: string[] }): void {
  if (!enabled) return;
  if (schema.properties) delete schema.properties.subagent_type;
  if (schema.required) schema.required = schema.required.filter(name => name !== "subagent_type");
  for (const [name, description] of Object.entries({
    model: "Optional provider/model override. Omit to inherit the parent's current model.",
    thinking: "Optional thinking level. Omit to inherit the parent's level.",
    name: "Optional task handle for addressing this session by name. This is a label, not a persona.",
    inherit_context: "If true, prepend a text snapshot of the parent conversation, excluding tool results and images. Default false. Never copies the parent system prompt.",
  })) {
    const property = schema.properties?.[name];
    if (property && typeof property === "object") Object.assign(property, { description });
  }
}

/** Keep the shared workflow API reference, replacing only persona-specific prose. */
export function nativeWorkflowDescription(description: string): string {
  if (!enabled) return description;
  return description
    .replace("agentType?: string, ", "")
    .replace("inherit the agent definition's own level, then the parent's", "inherit the parent's level")
    .replace(/opts\.agentType uses a custom subagent type[^\n]*\n\{\{typeList\}\}/, "Each agent is an independent native pi session. Legacy opts.agentType is ignored; no persona registry is loaded.")
    .replace("Subagents are told their final text IS the return value (not a human-facing message), so they return raw data.", "The task prompt must state the desired output format; no extra workflow system prompt is added.");
}
