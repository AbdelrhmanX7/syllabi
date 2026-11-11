// Sharing: read-only share + make a copy (phase 1) and "Can edit" (phase 2 part A: editors change the
// original through the normal study routes). Contract: apps/server/src/routes/share.ts.
import type { Question } from '@/lib/api/types';

export type ShareResourceType = 'notebook' | 'deck' | 'questions' | 'conceptMap';
/** 'viewer' = Can view (and copy); 'editor' = Can edit the original. The link is always 'viewer'. */
export type ShareRole = 'viewer' | 'editor';

export const ROLE_LABEL: Record<ShareRole, string> = { viewer: 'Can view', editor: 'Can edit' };

/** Someone other than the owner made the last change ("Edited by Maya"). */
export interface EditedBy {
  name: string;
  at: string | null;
}

/** What is being shared. deck / questions: a class (+ optional topic); otherwise the item's id. */
export interface ShareTarget {
  resourceType: ShareResourceType;
  resourceId: string;
  topic?: string | null;
  /** Shown in the sheet's title ("Share «Cell notes»"). */
  title: string;
}

export interface SharePerson {
  email: string;
  role: ShareRole;
  /** The account's name once that address signed in; null before. */
  name: string | null;
  joined: boolean;
}

/** The owner's view of a share. */
export interface Share {
  id: string;
  resourceType: ShareResourceType;
  resourceId: string;
  topic: string | null;
  title: string;
  people: SharePerson[];
  link: { role: ShareRole; url: string; token: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SharedWithMeItem {
  id: string;
  resourceType: ShareResourceType;
  title: string;
  ownerName: string;
  role: ShareRole;
  sharedAt: string;
  updatedAt: string;
  editedBy?: EditedBy | null;
}

export interface ForkRecord {
  resourceType: ShareResourceType;
  resourceId: string;
  topic: string | null;
  forkedFrom: { shareId: string; ownerName: string; title: string; resourceType: ShareResourceType };
  createdAt: string;
}

export interface NotebookContent {
  kind: string;
  title: string;
  version: number;
  /** Signed url of the board JSON; null = an empty board. */
  contentUrl: string | null;
  updatedAt: string;
  editedBy?: EditedBy | null;
}

export interface QuestionSetContent {
  className: string;
  topic: string | null;
  questions: Question[];
}

export interface ConceptMapContent {
  className: string | null;
  lecture: string | null;
  week: number | null;
  number: number | null;
  promptTerms: string[];
  editedBy?: EditedBy | null;
}

export interface SharedView {
  share: {
    id: string;
    resourceType: ShareResourceType;
    title: string;
    ownerName: string;
    isOwner: boolean;
    role: ShareRole;
    /** Editors only: the page / class / map id the study routes take, and the deck's topic. */
    resourceId?: string;
    topic?: string | null;
    updatedAt: string;
    editedBy?: EditedBy | null;
  };
  content: NotebookContent | QuestionSetContent | ConceptMapContent;
}

export interface ForkResult {
  resourceType: ShareResourceType;
  resourceId: string;
  topic: string | null;
  classId: string | null;
  /** True = this account already had a copy from this share; that copy is returned, none is made. */
  existing?: boolean;
}

export const RESOURCE_NOUN: Record<ShareResourceType, string> = {
  notebook: 'notebook',
  deck: 'flashcard deck',
  questions: 'question set',
  conceptMap: 'concept map',
};

export const RESOURCE_LABEL: Record<ShareResourceType, string> = {
  notebook: 'Notebook',
  deck: 'Flashcards',
  questions: 'Questions',
  conceptMap: 'Concept map',
};
