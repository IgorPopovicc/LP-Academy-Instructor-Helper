// === injected-sniffer.js ===
(function () {
  const ORIG_FETCH = window.fetch;
  const ORIG_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIG_XHR_SEND = XMLHttpRequest.prototype.send;
  const SCAN_MODES = {
    unanswered: 'unanswered',
    needsHelp: 'needsHelp'
  };
  const DEBUG_SCHEMA_FLAG = '__UDEMY_QA_DEBUG_SCHEMA';

  function stopScan(reason = 'user') {
    // Invalidate the current run first to force active loops to exit.
    const wasRunning = STATE.running;
    STATE.runId += 1;

    try {
      STATE.abort?.abort(reason);
    } catch {
      // noop
    }
    STATE.abort = null;

    STATE.running = false;
    setEnabled(false);
    if (wasRunning) {
      emitScanStatus({ status: 'stopped', reason, mode: STATE.mode });
    }

    console.warn('[Sniffer] FULLSCAN stopScan()', reason, 'runId now =', STATE.runId);
  }

  const STATE = {
    enabled: false,
    running: false,
    abort: null,
    runId: 0,
    mode: null
  };

  function setEnabled(v) {
    STATE.enabled = !!v;
  }

  function emitScanStatus(payload) {
    window.postMessage(
      {
        type: 'UDEMY_QA_SCAN_STATUS',
        ts: new Date().toISOString(),
        ...payload
      },
      '*'
    );
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function toBool(v, def = false) {
    if (v === undefined || v === null) return def;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'object') return def;
    const s = String(v).trim().toLowerCase();
    if (['false', '0', 'no', 'null', 'undefined', ''].includes(s)) return false;
    if (['true', '1', 'yes'].includes(s)) return true;
    return def;
  }

  function toNum(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function toStr(v, def = '') {
    return v == null ? def : String(v);
  }

  function toAbs(u) {
    if (!u) return '';
    try {
      return new URL(u, location.origin).toString();
    } catch {
      return String(u);
    }
  }

  function toIso(v) {
    const t = Date.parse(String(v || ''));
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }

  const get = (o, p, d) => {
    try {
      return p.split('.').reduce((x, k) => x?.[k], o);
    } catch {
      return d;
    }
  };

  const pick = (o, keys, d) => {
    for (const k of keys) {
      const v = get(o, k);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return d;
  };

  function isLikelyQaUrl(url) {
    return /questions|discussions|communication|course-questions|taught-courses-discussions|threads|instructor_communication/i.test(
      url
    );
  }

  function isTaughtCoursesUrl(url) {
    return /\/users\/me\/taught-courses-discussions\//.test(url);
  }

  // --- schema helper (za debug u konzoli: window.__udemySchema()) ---
  const __schema = new Map();

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function recordSchemaOne(obj, prefix = '') {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${k}` : k;
        const t = typeOf(v);
        if (!__schema.has(p)) {
          __schema.set(p, { count: 0, types: new Set(), examples: new Set() });
        }
        const s = __schema.get(p);
        s.count++;
        s.types.add(t);
        if (v !== undefined && v !== null && s.examples.size < 3) {
          s.examples.add(String(v).slice(0, 120));
        }
        if (t === 'object') recordSchemaOne(v, p);
        if (t === 'array' && v.length && typeof v[0] === 'object') {
          recordSchemaOne(v[0], p + '[]');
        }
      }
    }
  }

  function recordSchemaFromItems(items) {
    for (const it of items) {
      recordSchemaOne(it, 'normalized');
    }
  }

  function shouldRecordSchema() {
    return window[DEBUG_SCHEMA_FLAG] === true;
  }

  window.__udemySchema = function () {
    const out = [];
    for (const [k, v] of __schema.entries()) {
      out.push({
        key: k,
        count: v.count,
        types: [...v.types],
        examples: [...v.examples]
      });
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    console.table(out);
    return out;
  };

  function classifyDiscussion(item) {
    const replies = toNum(item?.num_replies, 0);
    const hasInstructorReply = item?.has_instructor_reply === true;
    // Udemy data can mark top answers with either `has_top_answer` or `is_featured`.
    const hasTopAnswer = item?.has_top_answer === true || item?.is_featured === true;

    return {
      num_replies: replies,
      has_instructor_reply: hasInstructorReply,
      has_top_answer: hasTopAnswer,
      pure_unanswered: replies === 0,
      needs_help: replies > 0 && !hasInstructorReply && !hasTopAnswer
    };
  }

  function withClassification(item) {
    const flags = classifyDiscussion(item);
    return {
      ...item,
      ...flags,
      answered: flags.num_replies > 0 || flags.has_instructor_reply
    };
  }

  function shouldKeepForMode(mode, item) {
    if (mode === SCAN_MODES.unanswered) return item.pure_unanswered === true;
    if (mode === SCAN_MODES.needsHelp) return item.needs_help === true;
    return true;
  }

  // ----------------- Normalizers -----------------
  function normalizeCourse(r) {
    const id = toStr(pick(r, ['id']), '');
    const title = toStr(pick(r, ['title']), '');
    const url = toAbs(pick(r, ['url', 'web_url']));

    return {
      type: 'course',
      courseId: id,
      courseTitle: title,
      courseInfo: {
        id,
        title,
        url,
        language: get(r, 'locale.locale') || get(r, 'locale') || undefined
      },
      link: url || (id ? `${location.origin}/course/${id}/` : ''),
      answered: false
    };
  }

  function normalizeDiscussion(r) {
    const id = pick(r, ['id', 'question_id', 'discussion_id', 'pk']);
    const title = pick(r, ['title', 'subject', 'question', 'headline', 'attributes.title']);
    const body = pick(r, ['body', 'question_context', 'content', 'attributes.body']);

    const link = toAbs(pick(r, ['url', 'web_url', 'permalink', 'links.html', 'learning_url']));
    const learning_url = toAbs(pick(r, ['learning_url', 'links.learning', 'learningPath']));
    const permalink = toAbs(pick(r, ['permalink', 'links.html']));

    const courseId = toStr(
      pick(
        r,
        [
          'course.id',
          'course.pk',
          'course_id',
          'courseId',
          'course_pk',
          'related_object.id',
          'course',
          'attributes.course_id',
          'attributes.course',
        ],
        ''
      ),
      ''
    ).trim();

    const courseTitle = toStr(
      pick(
        r,
        ['course.title', 'course_name', 'related_object.title', 'attributes.course_title'],
        ''
      ),
      ''
    ).trim();

    const courseSlug = pick(r, ['course.slug', 'course_slug']);
    const courseLang = get(r, 'course.locale') || pick(r, ['course.language']);
    const courseUrl = toAbs(pick(r, ['course.url', 'course.web_url']));

    const lectureId = pick(r, ['lecture.id', 'lecture', 'lecture_id']);
    const lectureTitle = pick(r, ['lecture.title', 'lecture_name']);
    const lectureNumber = pick(r, ['lecture.number']);
    const sectionTitle = pick(r, ['lecture.section_title', 'section.title']);

    const authorId = pick(r, ['user.id', 'author.id', 'user', 'owner.id']);
    const authorName = pick(r, [
      'user.name',
      'author.name',
      'owner.name',
      'user.full_name',
      'user.display_name'
    ]);
    const authorTitle = pick(r, ['user.title', 'author.title']);
    const authorAvatar = toAbs(pick(r, ['user.image_50x50', 'user.avatar', 'author.avatar_url']));
    const authorLocale = pick(r, ['user.locale', 'user_language']);

    const created_at = toIso(
      pick(r, ['created', 'created_at', 'attributes.created', 'creation_time'])
    );
    const updated_at = toIso(pick(r, ['updated', 'updated_at', 'attributes.updated']));
    const last_activity_time = toIso(
      pick(r, ['last_activity_time', 'last_activity', 'last_reply_at'])
    );
    const last_instructor_viewed_time = toIso(pick(r, ['last_instructor_viewed_time']));

    const num_replies = toNum(
      pick(
        r,
        [
          'num_replies',
          'replies_count',
          'answers_count',
          'attributes.num_replies',
          'reply_count'
        ],
        0
      )
    );

    const num_upvotes = toNum(
      pick(r, ['num_upvotes', 'upvotes_count', 'votes', 'attributes.num_upvotes'], 0)
    );

    const has_instructor_reply = toBool(
      pick(
        r,
        [
          'has_instructor_reply',
          'is_instructor_replied',
          'instructor_replied',
          'attributes.has_instructor_reply'
        ],
        false
      )
    );

    // Napomena: taught-courses-discussions često NE vraća has_top_answer.
    // Zato ga držimo ako postoji, ali se za “top answer” oslanjamo i na is_featured.
    const has_top_answer = toBool(
      pick(
        r,
        [
          'has_top_answer',
          'attributes.has_top_answer',
          'top_answer',
          'attributes.top_answer'
        ],
        false
      )
    );

    const unread = toBool(pick(r, ['unread', 'is_unread', 'attributes.unread'], false));
    const is_featured = toBool(pick(r, ['is_featured', 'featured'], false));
    const language = pick(r, ['language', 'locale']);

    const answered = num_replies > 0 || has_instructor_reply;

    let attachments = [];
    const attArr = pick(r, ['attachments', 'attributes.attachments'], []);
    if (Array.isArray(attArr)) {
      attachments = attArr
        .map((a) => ({
          type: pick(a, ['type', 'attachment_type']),
          url: toAbs(pick(a, ['url', 'file_url', 'src'])),
          name: pick(a, ['name', 'filename', 'title'])
        }))
        .filter((x) => x.url || x.name);
    }

    return {
      type: 'discussion',
      id,
      title: toStr(title, '').trim(),
      body: toStr(body, '').trim(),

      link:
        link ||
        learning_url ||
        permalink ||
        (id ? `${location.origin}/instructor/communication/qa/${id}/detail` : ''),
      learning_url,
      permalink,

      course: courseId || courseTitle,
      courseId,
      courseTitle,
      courseInfo: {
        id: courseId || undefined,
        title: courseTitle || undefined,
        slug: courseSlug,
        url: courseUrl,
        language: courseLang
      },

      lecture: {
        id: lectureId,
        title: lectureTitle,
        number: lectureNumber ? Number(lectureNumber) : undefined,
        section_title: sectionTitle
      },

      author: authorName,
      authorInfo: {
        id: authorId,
        name: authorName,
        title: authorTitle,
        avatar_url: authorAvatar,
        locale: authorLocale
      },

      time: last_activity_time || created_at || updated_at,
      created_at,
      updated_at,
      last_activity_time,
      last_instructor_viewed_time,

      num_replies,
      num_upvotes,
      has_instructor_reply,
      has_top_answer,
      unread,
      is_featured,
      language,

      answered,
      attachments
    };
  }

  function normalizeItems(json) {
    const arr = Array.isArray(json)
      ? json
      : Array.isArray(json.results)
        ? json.results
        : Array.isArray(json.items)
          ? json.items
          : Array.isArray(json.data)
            ? json.data
            : Array.isArray(json.messages)
              ? json.messages
              : [];

    const out = [];
    for (const r of arr) {
      const klass = get(r, '_class');

      if (klass === 'course') {
        out.push(normalizeCourse(r));
        continue;
      }

      if (klass === 'course_discussion' || !klass) {
        out.push(normalizeDiscussion(r));
        continue;
      }
    }
    return out;
  }

  // ----------------- FULLSCAN (NO replies endpoint) -----------------
  async function fullScanAllDiscussions(mode) {
    const scanMode = mode === SCAN_MODES.needsHelp ? SCAN_MODES.needsHelp : SCAN_MODES.unanswered;

    if (STATE.running) {
      console.warn('[Sniffer] FULLSCAN already running - stopping and restarting');
      stopScan('restart');
    }

    STATE.running = true;
    STATE.mode = scanMode;
    STATE.runId += 1;
    const myRunId = STATE.runId;

    STATE.abort = new AbortController();
    clearQaBuffer();
    setEnabled(true);
    emitScanStatus({ status: 'running', mode: scanMode, runId: myRunId });

    console.log('[Sniffer] FULLSCAN started, mode =', scanMode, 'runId=', myRunId);

    const base = new URL('/api-2.0/users/me/taught-courses-discussions/', location.origin);

    base.searchParams.set('page_size', scanMode === SCAN_MODES.needsHelp ? '50' : '100');
    base.searchParams.set('ordering', '-last_activity');

    base.searchParams.set(
      'fields[course_discussion]',
      '@default,course,user,related_object,is_following,is_instructor,last_reply,last_instructor_viewed_time,learning_url,is_featured,num_upvotes,is_upvoted,num_replies,has_instructor_reply,has_top_answer,pt_question,has_ai_reply'
    );
    base.searchParams.set('fields[course]', '@default,id,title,url,locale,image_125_H,image_200_H');
    base.searchParams.set('fields[user]', '@default');

    // Keep server-side filters conservative; final classification is always enforced client-side.
    if (scanMode === SCAN_MODES.needsHelp) {
      base.searchParams.set('unread', 'false');
      base.searchParams.set('unanswered', 'true');
      base.searchParams.set('unresponded', 'false');
      base.searchParams.set('has_ai_reply', 'false');
      base.searchParams.set('update_last_instructor_viewed_time', 'false');
    } else if (scanMode === SCAN_MODES.unanswered) {
      base.searchParams.set('unanswered', 'true');
    }

    let pageUrl = base.toString();
    const seenIds = new Set();
    let status = 'finished';
    let errorMessage = '';

    // retry helper (502/503/504/429 su tipično privremeni)
    async function fetchWithRetry(url, opts, maxAttempts = 5) {
      let attempt = 0;
      while (true) {
        attempt++;
        if (opts?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const res = await ORIG_FETCH(url, opts);

        if (res.ok) return res;

        const retriable = [429, 502, 503, 504].includes(res.status);
        if (!retriable || attempt >= maxAttempts) return res;

        const delayMs = Math.min(8000, 500 * Math.pow(2, attempt - 1)); // 500,1k,2k,4k,8k
        console.warn('[Sniffer] FULLSCAN retry', attempt, 'status', res.status, 'delay', delayMs, url);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    try {
      while (pageUrl) {
        if (STATE.abort.signal.aborted) {
          status = 'aborted';
          console.warn('[Sniffer] FULLSCAN aborted (signal)');
          break;
        }
        if (STATE.runId !== myRunId) {
          console.warn('[Sniffer] FULLSCAN superseded by newer run');
          break;
        }

        const res = await fetchWithRetry(
          pageUrl,
          {
            credentials: 'include',
            headers: { 'x-requested-with': 'XMLHttpRequest' },
            signal: STATE.abort.signal
          },
          5
        );

        if (!res.ok) {
          status = 'error';
          errorMessage = `HTTP ${res.status} while scanning ${pageUrl}`;
          console.warn('[Sniffer] FULLSCAN page failed', res.status, pageUrl);
          break;
        }

        const json = await res.json();
        const items = normalizeItems(json);

        const out = [];

        for (const d of items) {
          if (d.type !== 'discussion') continue;

          const merged = withClassification(d);
          if (!shouldKeepForMode(scanMode, merged)) continue;

          const k = String(merged.id ?? merged.link ?? '');
          if (!k || seenIds.has(k)) continue;
          seenIds.add(k);
          out.push(merged);
        }

        if (out.length) {
          window.postMessage(
            {
              type: 'UDEMY_QA_DATA',
              from: `fullscan-${scanMode}`,
              url: pageUrl,
              count: out.length,
              items: out
            },
            '*'
          );
        }

        pageUrl = json && json.next ? toAbs(json.next) : null;
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch (e) {
      if (e?.name === 'AbortError') {
        status = 'aborted';
        console.warn('[Sniffer] FULLSCAN aborted (AbortError)');
      } else {
        status = 'error';
        errorMessage = String(e?.message || e || 'Unknown scan error');
        console.warn('[Sniffer] FULLSCAN error', e);
      }
    } finally {
      if (STATE.runId !== myRunId) {
        console.warn('[Sniffer] FULLSCAN finally skipped - newer run exists');
        return;
      }

      setEnabled(false);
      STATE.abort = null;
      STATE.running = false;
      STATE.mode = null;

      emitScanStatus({
        status,
        mode: scanMode,
        runId: myRunId,
        count: seenIds.size,
        error: errorMessage || undefined
      });

      console.log('[Sniffer] FULLSCAN finished, mode =', scanMode, 'unique discussions =', seenIds.size);
    }
  }

  // ----------------- Passive sniff (fetch / XHR) -----------------
  async function fetchWrapper(input, init) {
    const res = await ORIG_FETCH(input, init);

    if (!STATE.enabled) return res;

    try {
      const url = typeof input === 'string' ? input : input.url;
      if (url && (isLikelyQaUrl(url) || isTaughtCoursesUrl(url))) {
        const clone = res.clone();
        const ct = clone.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          clone
            .json()
            .then((json) => {
              const items = normalizeItems(json);
              if (items.length) {
                if (shouldRecordSchema()) {
                  recordSchemaFromItems(items);
                }
                window.postMessage(
                  {
                    type: 'UDEMY_QA_DATA',
                    from: 'fetch',
                    url,
                    count: items.length,
                    items
                  },
                  '*'
                );
              }
            })
            .catch(() => {});
        }
      }
    } catch {
      // ignore
    }
    return res;
  }

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__udemy_url = url;
    return ORIG_XHR_OPEN.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        if (!STATE.enabled) return;
        const url = this.__udemy_url || '';
        if (url && (isLikelyQaUrl(url) || isTaughtCoursesUrl(url))) {
          const ct = this.getResponseHeader('content-type') || '';
          if (ct.includes('application/json')) {
            const json = JSON.parse(this.responseText);
            const items = normalizeItems(json);
            if (items.length) {
              if (shouldRecordSchema()) {
                recordSchemaFromItems(items);
              }
              window.postMessage(
                {
                  type: 'UDEMY_QA_DATA',
                  from: 'xhr',
                  url,
                  count: items.length,
                  items
                },
                '*'
              );
            }
          }
        }
      } catch {
        // ignore
      }
    });
    return ORIG_XHR_SEND.apply(this, arguments);
  };

  // ----------------- Shared buffer & control -----------------
  const QA_BUFFER_LIMIT = 5000;
  window.__udemyQaBuffer = window.__udemyQaBuffer || [];
  window.__udemyQaBufferKeys = window.__udemyQaBufferKeys || new Set();

  function qaBufferKey(item) {
    const id = item?.id ?? item?.question_id ?? item?.discussion_id;
    if (id !== undefined && id !== null && String(id).trim()) {
      return `id:${String(id).trim()}`;
    }

    const link = item?.link || item?.permalink || item?.learning_url;
    if (link && String(link).trim()) {
      return `link:${String(link).trim()}`;
    }

    return `fallback:${String(item?.title || '').trim().toLowerCase()}|${String(item?.created_at || item?.time || item?.last_activity_time || '').trim().toLowerCase()}|${String(item?.author || '').trim().toLowerCase()}`;
  }

  function addToQaBuffer(items) {
    for (const item of items) {
      const key = qaBufferKey(item);
      if (window.__udemyQaBufferKeys.has(key)) continue;

      window.__udemyQaBufferKeys.add(key);
      window.__udemyQaBuffer.push(item);
    }

    if (window.__udemyQaBuffer.length > QA_BUFFER_LIMIT) {
      const overflow = window.__udemyQaBuffer.length - QA_BUFFER_LIMIT;
      const dropped = window.__udemyQaBuffer.splice(0, overflow);
      for (const item of dropped) {
        window.__udemyQaBufferKeys.delete(qaBufferKey(item));
      }
    }
  }

  function clearQaBuffer() {
    window.__udemyQaBuffer.length = 0;
    window.__udemyQaBufferKeys.clear();
  }

  window.__dumpUdemyQa = () => window.__udemyQaBuffer.slice();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;

    const d = ev?.data;
    if (!d || typeof d !== 'object') return;

    if (d.type === 'UDEMY_QA_DATA' && Array.isArray(d.items)) {
      addToQaBuffer(d.items);
    }

    if (d.type === 'UDEMY_QA_COLLECTED_REQUEST') {
      window.postMessage(
        {
          type: 'UDEMY_QA_COLLECTED_RESPONSE',
          from: 'buffer',
          url: location.href,
          count: window.__udemyQaBuffer.length,
          items: window.__udemyQaBuffer
        },
        '*'
      );
    }

    if (d.type === 'UDEMY_QA_CLEAR_BUFFER') {
      clearQaBuffer();
    }

    if (d.type === 'UDEMY_QA_FULLSCAN') {
      const mode = d.mode === SCAN_MODES.needsHelp ? SCAN_MODES.needsHelp : SCAN_MODES.unanswered;
      fullScanAllDiscussions(mode).catch((e) =>
        console.warn('[Sniffer] FULLSCAN error', e)
      );
    }

    if (d.type === 'UDEMY_QA_STOP_SCAN') {
      stopScan('user');
    }
  });

  window.fetch = fetchWrapper;
  console.log('[Sniffer] Udemy QA sniffer attached (FULLSCAN: unanswered / needsHelp; NO replies endpoint)');
})();
