export interface PaperSection {
  index: number; name: string; description: string; durationMinutes: number; sectionTimerMinutes: number | null;
  marksPerQuestion: number; negativeMarks: number; randomizeQuestions: boolean; questionIds: string[];
}
export interface PaperQuestion {
  id: string; sectionIndex: number; type: string; text: string; html: string | null;
  options: { id: number; text: string }[]; marks: number; negativeMarks: number; attachments: unknown[];
}
export interface PaperCandidate {
  id: string; candidateCode?: string; applicationNo?: string; rollNumber: string; name: string; gender: string | null;
  seatNumber: number | null; labId: string | null; passwordHash: string; dobHash: string | null; photo: unknown;
}
export interface PaperPayload {
  packageId: string;
  center: { code: string; name: string };
  exam: {
    id: string; title: string; type?: string; instructions?: string; totalDurationMinutes: number; totalMarks?: number;
    scheduledStart?: string; scheduledEnd?: string;
    settings: { randomizeSections: boolean; randomizeOptions: boolean; allowReview: boolean; autoSubmitOnTimeout: boolean; lateEntryMinutes: number };
    security?: unknown; sectionTimers?: boolean; sections: PaperSection[];
  };
  questions: PaperQuestion[];
  candidates: PaperCandidate[];
  seats: { labId: string; seatNumber: number; systemNumber: number | null; rollNumber: string }[];
  seatMapEnforced: boolean;
}

export type ExamState = 'not_downloaded' | 'downloading' | 'failed' | 'locked' | 'unlocked' | 'running' | 'paused' | 'ended';
export type AttemptStatus = 'not_started' | 'in_progress' | 'submitted' | 'auto_submitted' | 'force_submitted' | 'disqualified' | 'absent';
export const FINAL_STATUSES: AttemptStatus[] = ['submitted', 'auto_submitted', 'force_submitted', 'disqualified', 'absent'];

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
