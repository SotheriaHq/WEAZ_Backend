export type ClockMode = 'real' | 'offset' | 'fixed';

export interface ClockEffectiveState {
  mode: ClockMode;
  realNow: string;
  effectiveNow: string;
  offsetDays?: number;
  offsetHours?: number;
  fixedTime?: string;
}
