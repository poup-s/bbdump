/** Choices of the anonymized duplicate, as sent to the main process (see main/sync/anonymizedCopy.ts) */
export type AnonymizeKind = 'partial' | 'email' | 'phone' | 'name' | 'address' | 'ip' | 'secret' | 'null';

export interface AnonymizeChoices {
  columns: Array<{ table: string; column: string; kind: AnonymizeKind }>;
  /** Tables copied without their rows */
  emptyTables: string[];
}
