// Display-only names for a pending stop, so the human sees WHAT they approve ("Onboarding: …", "Onboarding - Weekly first"),
// not just ids. Filled by request_stop from the Adapty test it already read. The gate never reads this: it decides on ids.

export interface StopLabel {
  testTitle: string;
  armName: string;
}

export type StopLabels = Map<string, StopLabel>;
