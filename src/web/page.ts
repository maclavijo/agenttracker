/** Options that shape the server-rendered page shell. */
export interface WebPageOptions {
  /**
   * Whether `WEB_UI_HUMAN_TOKEN` was configured. Only this boolean reaches the
   * browser; the token itself never does.
   */
  readonly commentsEnabled: boolean;
}

/**
 * The single self-contained page: server-rendered HTML with inline CSS and JS,
 * no build step and no framework.
 *
 * The shell is deliberately plain. The script fetches the existing JSON API
 * (`GET /issues`, `GET /issues/:id`, `GET /issues/:id/events`), renders the
 * list and the detail view, posts comments through the server-side proxy
 * `POST /ui/issues/:id/comments`, and appends live events from `GET /stream`.
 */
export function renderPage(options: WebPageOptions): string {
  const commentsEnabled = options.commentsEnabled ? 'true' : 'false';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agenttracker</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: Canvas;
    color: CanvasText;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px;
    line-height: 1.5;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid #8884;
  }
  .brand { color: inherit; font-weight: 600; text-decoration: none; }
  .connection {
    border: 1px solid currentColor;
    border-radius: 999px;
    padding: 1px 10px;
    font-size: 13px;
  }
  .connection[data-state="live"] { color: #1a7f37; }
  .connection[data-state="connecting"],
  .connection[data-state="reconnecting"] { color: #9a6700; }
  .connection[data-state="error"],
  .connection[data-state="unavailable"] { color: #cf222e; }
  main { max-width: 960px; margin: 0 auto; padding: 16px; }
  .panel { margin-bottom: 28px; }
  .page-title, .panel-title, .issue-title { margin: 0 0 8px; }
  .page-title, .panel-title { font-size: 18px; }
  .issue-title { font-size: 22px; }
  .issue-key { color: GrayText; font-weight: 400; }
  .hint { margin: 0 0 12px; color: GrayText; font-size: 13px; }
  .state {
    margin: 12px 0;
    padding: 14px 16px;
    border: 1px dashed #8888;
    border-radius: 6px;
  }
  .state-title { margin: 0; font-weight: 600; }
  .state-detail { margin: 4px 0 0; color: GrayText; }
  .state-retry { margin-top: 10px; }
  table.issues { width: 100%; border-collapse: collapse; }
  table.issues th, table.issues td {
    padding: 6px 8px;
    border-bottom: 1px solid #8884;
    text-align: left;
    vertical-align: top;
  }
  table.issues th { color: GrayText; font-size: 13px; font-weight: 600; }
  .issue-key { font-variant-numeric: tabular-nums; }
  .issue-link { color: inherit; }
  .updated { color: GrayText; font-size: 13px; }
  .back-link { font-size: 13px; }
  .meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 12px;
    margin: 12px 0;
  }
  .meta-term { color: GrayText; }
  .meta-value { margin: 0; }
  .issue-body { margin: 12px 0; white-space: pre-wrap; }
  .timeline { margin: 0; padding: 0; list-style: none; border-left: 2px solid #8884; }
  .event { padding: 8px 0 8px 12px; border-bottom: 1px solid #8883; }
  .event-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .event-time { color: GrayText; font-size: 13px; }
  .event-type { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .event-body { margin: 6px 0 0; white-space: pre-wrap; }
  .actor { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
  .actor-type {
    border: 1px solid currentColor;
    border-radius: 3px;
    padding: 0 6px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .actor-agent .actor-type { color: #0969da; }
  .actor-human .actor-type { color: #8250df; }
  .actor-id { color: GrayText; }
  .timeline-empty { padding: 8px 0 8px 12px; color: GrayText; }
  .comment-form { display: flex; flex-direction: column; gap: 8px; }
  .field-label { font-weight: 600; }
  .comment-body { width: 100%; padding: 8px; font: inherit; }
  .form-actions { display: flex; align-items: center; gap: 12px; }
  .form-status { margin: 0; font-size: 13px; }
  .form-status[data-state="error"] { color: #cf222e; }
  .form-status[data-state="success"] { color: #1a7f37; }
</style>
</head>
<body data-comments-enabled="${commentsEnabled}">
<header>
  <a class="brand" href="#/">agenttracker</a>
  <span id="connection" class="connection" data-state="connecting" role="status" aria-live="polite">connecting…</span>
</header>
<main id="app">
  <p class="state">Loading…</p>
</main>
<noscript><p class="state">This UI requires JavaScript.</p></noscript>
<script>
(function () {
  'use strict';

  var app = document.getElementById('app');
  var connection = document.getElementById('connection');
  var commentsEnabled = document.body.getAttribute('data-comments-enabled') === 'true';

  var state = {
    view: 'none',
    issueId: null,
    seen: Object.create(null),
    maxSeq: 0,
    stream: null,
    streamUrl: null
  };

  function element(tag, className, text) {
    var node = document.createElement(tag);

    if (className) {
      node.className = className;
    }

    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }

    return node;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function setConnection(kind, label) {
    connection.setAttribute('data-state', kind);
    connection.textContent = label;
  }

  function describe(error) {
    if (error && typeof error.message === 'string' && error.message !== '') {
      return error.message;
    }

    return String(error);
  }

  function stateBox(className, title, detail, retry) {
    var box = element('div', 'state ' + className);
    box.appendChild(element('p', 'state-title', title));

    if (detail) {
      box.appendChild(element('p', 'state-detail', detail));
    }

    if (retry) {
      var button = element('button', 'state-retry', 'Retry');
      button.type = 'button';
      button.addEventListener('click', retry);
      box.appendChild(button);
    }

    return box;
  }

  function getJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (response) {
      if (!response.ok) {
        throw new Error('Request failed with status ' + response.status + '.');
      }

      return response.json();
    });
  }

  function formatTime(value) {
    var date = new Date(value);

    if (isNaN(date.getTime())) {
      return String(value);
    }

    return date.toLocaleString();
  }

  function actorBadge(actorType, actorId) {
    var human = actorType === 'human';
    var badge = element('span', 'actor ' + (human ? 'actor-human' : 'actor-agent'));
    badge.appendChild(element('span', 'actor-type', human ? 'HUMAN' : 'AGENT'));
    badge.appendChild(element('span', 'actor-id', String(actorId)));
    return badge;
  }

  function appendEvent(event) {
    if (!event || typeof event.seq !== 'number' || state.seen[event.seq]) {
      return false;
    }

    state.seen[event.seq] = true;

    if (event.seq > state.maxSeq) {
      state.maxSeq = event.seq;
    }

    var timeline = document.getElementById('timeline');

    if (!timeline) {
      return false;
    }

    var empty = timeline.querySelector('.timeline-empty');

    if (empty) {
      empty.remove();
    }

    var row = element('li', 'event');
    var head = element('div', 'event-head');
    head.appendChild(element('time', 'event-time', formatTime(event.at)));
    head.appendChild(element('span', 'event-type', String(event.type)));
    head.appendChild(actorBadge(event.actorType, event.actorId));
    row.appendChild(head);

    if (event.type === 'comment.created' && event.payload && typeof event.payload.body === 'string') {
      row.appendChild(element('p', 'event-body', event.payload.body));
    }

    timeline.appendChild(row);
    return true;
  }

  function renderEvents(events) {
    var timeline = document.getElementById('timeline');

    if (!timeline) {
      return;
    }

    clear(timeline);
    state.seen = Object.create(null);
    state.maxSeq = 0;

    if (!events.length) {
      timeline.appendChild(element('li', 'timeline-empty', 'No activity yet.'));
      return;
    }

    events.forEach(appendEvent);
  }

  function timelineSection() {
    var section = element('section', 'panel');
    section.appendChild(element('h2', 'panel-title', 'Timeline'));
    section.appendChild(element('p', 'hint', 'Oldest first; the actor type is marked on every event.'));

    var list = element('ol', 'timeline');
    list.id = 'timeline';
    section.appendChild(list);
    return section;
  }

  function appendMeta(list, label, value) {
    list.appendChild(element('dt', 'meta-term', label));
    list.appendChild(element('dd', 'meta-value', value));
  }

  function commentForm(issueId) {
    var section = element('section', 'panel');
    section.appendChild(element('h2', 'panel-title', 'Add comment'));

    var form = element('form', 'comment-form');
    form.id = 'comment-form';

    var label = element('label', 'field-label', 'Comment as human');
    label.setAttribute('for', 'comment-body');
    form.appendChild(label);

    var textarea = element('textarea', 'comment-body');
    textarea.id = 'comment-body';
    textarea.name = 'body';
    textarea.rows = 4;
    textarea.required = true;
    form.appendChild(textarea);

    var actions = element('div', 'form-actions');
    var button = element('button', 'comment-submit', 'Comment');
    button.type = 'submit';
    button.id = 'comment-submit';
    actions.appendChild(button);
    form.appendChild(actions);

    var status = element('p', 'form-status');
    status.id = 'comment-status';
    form.appendChild(status);

    if (!commentsEnabled) {
      textarea.disabled = true;
      button.disabled = true;
      status.textContent = 'Commenting is not configured for this server.';
      status.setAttribute('data-state', 'error');
    }

    form.addEventListener('submit', function (submitEvent) {
      submitEvent.preventDefault();

      if (textarea.disabled) {
        return;
      }

      postComment(issueId, textarea, button, status);
    });

    section.appendChild(form);
    return section;
  }

  function postComment(issueId, textarea, button, status) {
    var body = textarea.value.trim();

    if (body === '') {
      status.textContent = 'Write a comment first.';
      status.setAttribute('data-state', 'error');
      return;
    }

    button.disabled = true;
    status.textContent = 'Posting…';
    status.removeAttribute('data-state');

    fetch('/ui/issues/' + encodeURIComponent(issueId) + '/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ body: body })
    }).then(function (response) {
      if (!response.ok) {
        throw new Error('Comment failed with status ' + response.status + '.');
      }

      textarea.value = '';
      status.textContent = 'Comment posted.';
      status.setAttribute('data-state', 'success');

      return refreshTimeline(issueId).catch(function () {
        status.textContent = 'Comment posted, but the timeline could not be refreshed.';
        status.setAttribute('data-state', 'error');
      });
    }).catch(function (error) {
      status.textContent = 'Could not post the comment. ' + describe(error);
      status.setAttribute('data-state', 'error');
    }).then(function () {
      button.disabled = false;
    });
  }

  function refreshTimeline(issueId) {
    return getJson('/issues/' + encodeURIComponent(issueId) + '/events').then(function (payload) {
      if (state.view !== 'detail' || state.issueId !== issueId) {
        return;
      }

      renderEvents(payload && Array.isArray(payload.events) ? payload.events : []);
    });
  }

  function renderDetail(issue, events) {
    var header = element('section', 'panel');
    var back = element('a', 'back-link', '← All issues');
    back.href = '#/';
    header.appendChild(back);

    var title = element('h1', 'issue-title');
    title.appendChild(element('span', 'issue-key', '#' + issue.key));
    title.appendChild(document.createTextNode(' ' + issue.title));
    header.appendChild(title);

    var meta = element('dl', 'meta');
    appendMeta(meta, 'Status', issue.status);
    appendMeta(meta, 'Priority', String(issue.priority));
    appendMeta(meta, 'Assignee', issue.assignee === null ? 'unassigned' : issue.assignee);
    appendMeta(meta, 'Updated', formatTime(issue.updatedAt));
    header.appendChild(meta);

    header.appendChild(element('div', 'issue-body', issue.body === '' ? 'No description.' : issue.body));

    app.replaceChildren(header, timelineSection(), commentForm(issue.id));
    renderEvents(events);
  }

  function renderList(issues) {
    var section = element('section', 'panel');
    section.appendChild(element('h1', 'page-title', 'Issues'));

    if (issues.length === 0) {
      section.appendChild(
        stateBox('state-empty', 'No issues yet.', 'Agents can create issues through the HTTP API or the MCP server.')
      );
      app.replaceChildren(section);
      return;
    }

    section.appendChild(element('p', 'hint', 'Newest first. Select an issue to see its timeline.'));

    var table = element('table', 'issues');
    table.id = 'issue-list';

    var head = element('thead');
    var headRow = element('tr');
    ['#', 'Title', 'Status', 'Priority', 'Assignee', 'Updated'].forEach(function (label) {
      headRow.appendChild(element('th', null, label));
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = element('tbody');

    issues.forEach(function (issue) {
      var row = element('tr', 'issue-row');
      row.appendChild(element('td', 'issue-key', String(issue.key)));

      var titleCell = element('td', 'issue-title-cell');
      var link = element('a', 'issue-link', issue.title);
      link.href = '#/issues/' + encodeURIComponent(issue.id);
      titleCell.appendChild(link);
      row.appendChild(titleCell);

      row.appendChild(element('td', null, issue.status));
      row.appendChild(element('td', null, String(issue.priority)));
      row.appendChild(element('td', null, issue.assignee === null ? '—' : issue.assignee));
      row.appendChild(element('td', 'updated', formatTime(issue.updatedAt)));
      body.appendChild(row);
    });

    table.appendChild(body);
    section.appendChild(table);
    app.replaceChildren(section);
  }

  function showList() {
    state.view = 'list';
    state.issueId = null;
    app.replaceChildren(element('p', 'state', 'Loading issues…'));

    getJson('/issues').then(function (payload) {
      if (state.view !== 'list') {
        return;
      }

      renderList(payload && Array.isArray(payload.issues) ? payload.issues : []);
      connectStream(null);
    }).catch(function (error) {
      if (state.view !== 'list') {
        return;
      }

      app.replaceChildren(
        stateBox('state-error', 'Could not load issues.', describe(error), showList)
      );
    });
  }

  function showDetail(id) {
    state.view = 'detail';
    state.issueId = id;
    state.seen = Object.create(null);
    state.maxSeq = 0;
    app.replaceChildren(element('p', 'state', 'Loading issue…'));

    var base = '/issues/' + encodeURIComponent(id);

    Promise.all([getJson(base), getJson(base + '/events')]).then(function (results) {
      if (state.view !== 'detail' || state.issueId !== id) {
        return;
      }

      var issue = results[0];
      var events = results[1] && Array.isArray(results[1].events) ? results[1].events : [];
      renderDetail(issue, events);
      connectStream(state.maxSeq);
    }).catch(function (error) {
      if (state.view !== 'detail' || state.issueId !== id) {
        return;
      }

      app.replaceChildren(
        stateBox('state-error', 'Could not load this issue.', describe(error), function () {
          showDetail(id);
        })
      );
    });
  }

  function handleStreamEvent(message) {
    var event;

    try {
      event = JSON.parse(message.data);
    } catch (error) {
      return;
    }

    if (!event || typeof event.seq !== 'number') {
      return;
    }

    if (event.seq > state.maxSeq) {
      state.maxSeq = event.seq;
    }

    if (
      state.view === 'detail' &&
      event.entityType === 'issue' &&
      event.entityId === state.issueId
    ) {
      appendEvent(event);
    }
  }

  function closeStream() {
    if (state.stream) {
      state.stream.close();
    }

    state.stream = null;
    state.streamUrl = null;
  }

  function connectStream(since) {
    var url = since === null || since === undefined
      ? '/stream'
      : '/stream?since=' + encodeURIComponent(String(since));

    if (state.stream && state.streamUrl === url && state.stream.readyState !== 2) {
      return;
    }

    closeStream();

    if (typeof window.EventSource !== 'function') {
      setConnection('unavailable', 'live updates unavailable');
      return;
    }

    setConnection('connecting', 'connecting…');

    var source = new window.EventSource(url);
    state.stream = source;
    state.streamUrl = url;

    source.onopen = function () {
      if (state.stream === source) {
        setConnection('live', 'live');
      }
    };

    source.onerror = function () {
      if (state.stream === source) {
        setConnection('reconnecting', 'reconnecting…');
      }
    };

    ['issue.created', 'issue.updated', 'comment.created'].forEach(function (type) {
      source.addEventListener(type, function (message) {
        if (state.stream === source) {
          handleStreamEvent(message);
        }
      });
    });
  }

  function route() {
    var hash = window.location.hash.replace(/^#/, '');
    var match = /^\\/issues\\/([^/]+)$/.exec(hash);

    if (match && match[1]) {
      showDetail(decodeURIComponent(match[1]));
      return;
    }

    showList();
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('unhandledrejection', function (event) {
    event.preventDefault();
    setConnection('error', 'unexpected error');
  });

  route();

  if (state.view === 'list') {
    connectStream(null);
  }
})();
</script>
</body>
</html>
`;
}
