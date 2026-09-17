const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORTS)[number];
