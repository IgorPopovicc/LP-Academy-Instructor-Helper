export interface QaUser {
  id?: number | string;
  name?: string;
  title?: string;
  initials?: string;
  avatar_url?: string;
  locale?: string;
}

export interface QaCourse {
  id?: number | string;
  title?: string;
  slug?: string;
  url?: string;
  language?: string;
}

export interface QaLecture {
  id?: number | string;
  title?: string;
  number?: number;
  section_title?: string;
}

export interface QaAttachment {
  type?: string;           // image, file, code, etc.
  url?: string;
  name?: string;
}

export interface QaItem {
  // basic
  id?: number | string;
  title: string;
  body?: string;           // snippet/preview
  link: string;            // canonical link to the thread
  learning_url?: string;   // udemy learning url (if present)
  permalink?: string;

  // course / lecture
  course?: string;         // short – for filters (“533682” or course title)
  courseInfo?: QaCourse;
  lecture?: QaLecture;

  // author / meta
  author?: string;
  authorInfo?: QaUser;

  // times & status
  time?: string;                 // “10 hours ago” or ISO
  created_at?: string;
  updated_at?: string;
  last_activity_time?: string;
  last_instructor_viewed_time?: string;

  // counts & flags
  num_replies?: number;
  num_upvotes?: number;
  has_instructor_reply?: boolean;
  has_top_answer?: boolean;
  /**
   * answered = has ANY replies (student or instructor),
   * not necessarily instructor reply.
   */
  answered: boolean;
  unread?: boolean;
  is_featured?: boolean;
  language?: string;

  // extra
  tags?: string[];
  attachments?: QaAttachment[];

  // local inbox
  is_hidden?: boolean;
  is_important?: boolean;
  pure_unanswered?: boolean;
  needs_help?: boolean;

  // internal timestamp for sorting (ms since epoch)
  timestamp?: number;
}
