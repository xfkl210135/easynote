export type ISODateString = string;

export interface Folder {
  id: string;
  name: string;
  color?: string;
  parentId: string | null;
}

export interface Note {
  id: string;
  title: string;
  categoryId: string;
  tags: string[];
  favorite: boolean;
  content: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
  revision?: number;
  [key: string]: unknown;
}

export interface FileEntry {
  id: string;
  name: string;
  type: string;
  size: number;
  folderId: string;
  attachmentId?: string;
  dataUrl?: string;
  createdAt: ISODateString;
  [key: string]: unknown;
}

export type TaskValue = string | number | boolean | string[] | Record<string, unknown>[] | null;

export interface Task {
  id: string;
  values: Record<string, TaskValue>;
  sortOrder: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  completedAt?: ISODateString | null;
  revision?: number;
  [key: string]: unknown;
}

export interface TaskField {
  id: string;
  name: string;
  type: string;
  order: number;
  options: Record<string, unknown>[];
  config: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TaskView {
  id: string;
  filters: Record<string, unknown>[];
  sorts: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface ScheduleTimeSlot {
  startTime: string;
  endTime?: string;
}

export interface ScheduleEntry {
  id: string;
  title: string;
  date: string;
  allDay: boolean;
  startTime?: string;
  endTime?: string;
  timeSlots?: ScheduleTimeSlot[];
  notes?: string;
  color?: string;
  completed?: boolean;
  taskId?: string;
  noteId?: string;
  url?: string;
  urlLabel?: string;
  reminderMode?: "auto" | "none" | "custom";
  customReminderAt?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  revision?: number;
  [key: string]: unknown;
}

export interface ScheduleSeries extends ScheduleEntry {
  startDate: string;
  recurrenceType: "daily" | "weekdays" | "weekly" | "monthly";
  recurrenceInterval: number;
  weekdays?: number[];
  dayOfMonth?: number;
  until?: string;
  active?: boolean;
}

export interface ScheduleOccurrenceState {
  id: string;
  seriesId: string;
  date: string;
  completed: boolean;
  deleted: boolean;
  override: Record<string, unknown>;
  updatedAt: ISODateString;
  [key: string]: unknown;
}

export interface ScheduleDailyNote {
  id: string;
  date: string;
  content: string;
  updatedAt: ISODateString;
}

export type FocusPhase = "focus" | "awaitingBreak" | "break";
export type FocusStatus = "active" | "paused" | "completed" | "abandoned";

export interface FocusSession {
  id: string;
  label: string;
  taskId: string;
  scheduleEntryId: string;
  phase: FocusPhase;
  status: FocusStatus;
  focusMinutes: number;
  breakMinutes: number;
  startedAt: ISODateString;
  phaseStartedAt: ISODateString;
  endsAt: ISODateString;
  pausedAt: ISODateString | null;
  remainingMs: number;
  actualSeconds: number;
  focusCompletedAt?: ISODateString | null;
  completedAt: ISODateString | null;
  updatedAt: ISODateString;
  revision?: number;
}

export type ReviewPeriod = "daily" | "weekly" | "monthly";

export interface ReviewMetrics {
  completedTasks: number;
  completedSchedules: number;
  focusSessions: number;
  focusMinutes: number;
}

export interface ReviewEntry {
  id: string;
  periodType: ReviewPeriod;
  periodStart: string;
  periodEnd: string;
  answers: Record<string, string | number>;
  freeform: string;
  metrics: ReviewMetrics;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  revision?: number;
}

export type GoalStatus = "active" | "paused" | "completed" | "archived";

export interface Goal {
  id: string;
  title: string;
  description: string;
  startDate: string;
  dueDate: string;
  color: string;
  status: GoalStatus;
  progressMode: "automatic" | "manual";
  manualProgress: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
  revision?: number;
}

export interface Milestone {
  id: string;
  goalId: string;
  title: string;
  dueDate: string;
  weight: number;
  taskIds: string[];
  completed: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  deletedAt: ISODateString | null;
  revision?: number;
}

export interface WhiteboardNode {
  id: string;
  type: "text" | "note" | "task" | "image" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface WhiteboardEdge {
  id: string;
  sourceId: string;
  targetId: string;
  [key: string]: unknown;
}

export interface Whiteboard {
  id: string;
  title: string;
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
  viewport: { x: number; y: number; zoom: number };
  gridEnabled: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  revision?: number;
  [key: string]: unknown;
}

export interface Attachment {
  id: string;
  sha256: string;
  name: string;
  type: string;
  size: number;
  blob?: Blob;
  [key: string]: unknown;
}

export interface AppState {
  version: 8;
  categories: Folder[];
  files: FileEntry[];
  notes: Note[];
  tasks: Task[];
  taskFields: TaskField[];
  taskViews: TaskView[];
  scheduleEntries: ScheduleEntry[];
  scheduleSeries: ScheduleSeries[];
  scheduleOccurrenceStates: ScheduleOccurrenceState[];
  scheduleDailyNotes: ScheduleDailyNote[];
  focusSessions: FocusSession[];
  reviews: ReviewEntry[];
  goals: Goal[];
  milestones: Milestone[];
  whiteboards: Whiteboard[];
}

export type SaveStatus = "dirty" | "saving" | "saved" | "failed";

export interface PortableArchive extends AppState {
  format: "easynote-portable";
  exportedAt: ISODateString;
  safetyArchive?: Record<string, unknown>;
}
