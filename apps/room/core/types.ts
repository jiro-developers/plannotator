/**
 * Shared wire types for the self-hosted Plan Room service.
 *
 * A "room" is a server-stored plan document identified by a shortcode.
 * Teammates open the same /r/:code link, see everyone's annotations, and add
 * their own. Agents poll GET /api/rooms/:id/changes?since=<version> to pick up
 * new feedback and PUT plan updates back.
 *
 * These types are used by both the Bun server and the browser SPA — keep them
 * dependency-free.
 */

export type RoomAnnotationType = 'DELETION' | 'COMMENT' | 'GLOBAL_COMMENT';

/**
 * Lifecycle of an annotation from the agent's perspective:
 *  - open:      untouched, awaiting processing
 *  - answered:  the agent replied (question — plan unchanged)
 *  - reflected: the agent applied the change to the plan
 *  - declined:  the agent (or owner) decided not to apply it
 */
export type RoomAnnotationStatus = 'open' | 'answered' | 'reflected' | 'declined';

/** DOM-relative text position used by the viewer to restore a selection. */
export interface RoomAnnotationTextMeta {
  parentTagName: string;
  parentIndex: number;
  textOffset: number;
}

export interface RoomReply {
  author: string;
  text: string;
  createdA: number;
}

/**
 * A stored annotation: the viewer's anchor fields (compatible with
 * @plannotator/ui `Annotation`) plus server-managed collaboration state.
 */
export interface RoomAnnotation {
  id: string;
  type: RoomAnnotationType;
  /** The selected text this annotation anchors to ('' for GLOBAL_COMMENT). */
  originalText: string;
  /** Comment body (absent for pure DELETION marks). */
  text?: string;
  author: string;
  createdA: number;
  // Viewer anchor passthrough (legacy block coords + web-highlighter metas)
  blockId?: string;
  startOffset?: number;
  endOffset?: number;
  startMeta?: RoomAnnotationTextMeta;
  endMeta?: RoomAnnotationTextMeta;
  isQuickLabel?: boolean;
  quickLabelTip?: string;
  // Server-managed
  seq: number;
  votes: string[];
  status: RoomAnnotationStatus;
  replies: RoomReply[];
}

/** Input shape accepted by POST /api/rooms/:id/annotations (client-generated). */
export type RoomAnnotationInput = Omit<RoomAnnotation, 'seq' | 'votes' | 'status' | 'replies'>;

/**
 * Teammate → agent request flags. The room UI raises these; the polling agent
 * acts on them at its next cycle and clears them. Raising a signal bumps
 * `version` so the agent's changes-poll picks it up.
 */
export interface RoomSignals {
  /** "커밋해줘" — commit+push the accumulated plan changes at the next cycle. */
  commitRequestedA?: number;
  /** Who asked (display name), for the commit body / cycle report. */
  commitRequestedBy?: string;
  /**
   * planVersion as of the agent's last commit report (DELETE /signals/commit).
   * The UI offers the commit button only while planVersion is ahead of this.
   */
  lastCommittedPlanVersion?: number;
}

export interface RoomChangelogEntry {
  version: number;
  planVersion?: number;
  note: string;
  author: string;
  createdA: number;
}

/** A superseded plan body, kept so the UI can diff between versions. */
export interface RoomPlanVersion {
  planVersion: number;
  plan: string;
  createdA: number;
}

export interface RoomDoc {
  id: string;
  title: string;
  plan: string;
  /** Bumps only when the plan markdown itself changes. */
  planVersion: number;
  /** Bumps on every mutation (plan, annotation, reply, vote, status). */
  version: number;
  seqCounter: number;
  createdA: number;
  updatedA: number;
  annotations: RoomAnnotation[];
  changelog: RoomChangelogEntry[];
  signals?: RoomSignals;
  /**
   * When the agent last polled /changes. A heartbeat, not a change — updated
   * WITHOUT bumping `version` (else the agent would chase its own tail).
   * Browsers read it via the X-Agent-Last-Seen response header each tick.
   */
  agentLastSeenA?: number;
  /**
   * Superseded plan bodies (v1..current-1), newest last; the current body
   * lives in `plan`. Absent on docs created before this field existed.
   * Excluded from snapshots — fetched per version via /plan-versions/:v.
   */
  planHistory?: RoomPlanVersion[];
}

/** Snapshot returned by GET /api/rooms/:id and /changes. */
export interface RoomSnapshot {
  id: string;
  title: string;
  plan: string;
  planVersion: number;
  version: number;
  createdA: number;
  updatedA: number;
  annotations: RoomAnnotation[];
  changelog: RoomChangelogEntry[];
  signals?: RoomSignals;
  agentLastSeenA?: number;
}

export function toSnapshot(doc: RoomDoc): RoomSnapshot {
  const { seqCounter: _seqCounter, planHistory: _planHistory, ...snapshot } = doc;
  return snapshot;
}
