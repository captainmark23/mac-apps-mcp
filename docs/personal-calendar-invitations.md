# Personal iCloud calendar invitations

This capability creates an organizer event with real attendees using iCloud CalDAV
scheduling. An ordinary `calendar_create_event` creates only a private entry.
An invitation requests time on the recipient's calendar; it cannot force the
recipient to accept or mark their time busy.

## Why CalDAV

The existing MCP uses Calendar's SQLite database for reads and JXA for writes.
The macOS Calendar scripting dictionary exposes attendee email and participation
as read-only. Apple's [EventKit documentation](https://developer.apple.com/documentation/eventkit/ekcalendaritem/attendees)
also explicitly rules out adding attendees. The native event editor requires an
interactive human and is not a headless invitation transport.

The transport adapts the conditional PUT, organizer verification, event read-back
and status interpretation from [Casamia PR #587](https://github.com/captainmark23/casamia/pull/587),
merged at `b2cb0478e794782681d5eb13fce1f290cb72209e`. It adds durable local operation
reservations, authenticated-principal ownership and explicit scheduling privileges.
It uses [RFC 6638 automatic scheduling](https://www.rfc-editor.org/rfc/rfc6638.html),
not a mail attachment or a separate scheduling POST. No new agent or worker runs.

## Owner-run setup and read-only check

Use the reviewed checkout on the Mac that will run this MCP. The owner performs
these steps locally. Assistants must not run setup, collect passwords in chat,
inspect Keychain values or read environment-file values.

1. Install dependencies and build using `npm ci` and `npm run build`.
2. Create an [Apple app-specific password](https://support.apple.com/en-us/102654)
   for this integration. Do not use the main Apple account password.
3. In the owner's interactive terminal run:

   ```sh
   node build/calendar/invitation-setup.js --configure
   ```

4. Enter the account email and the hidden password. Choose the personal calendar
   by its displayed name **and exact collection URL**, then choose the organizer
   from the authenticated account's addresses. Setup reads account/calendar
   properties and verifies ownership, VEVENT support, creation privileges,
   automatic scheduling and scheduling-outbox privileges. Review and type `SAVE`.
5. Check the connection without sending an event:

   ```sh
   node build/calendar/invitation-setup.js --check
   ```

The packaged CLI is `calendar-invitations --configure` or `--check` when installed.
Neither command sends an event. Check uses only OPTIONS and PROPFIND; discovery
uses PROPFIND and follows at most four redirects, validating every destination as
an HTTPS iCloud CalDAV host before forwarding authentication. Runtime event
requests never follow redirects. Responses are limited to 1 MiB and requests to
15 seconds. XML external entities and DTDs are rejected.

After `SAVE`, one generic-password item is created in the login Keychain under
service `mac-apps-mcp.calendar-invitations`, with a random account identifier.
It contains the account email and app-specific password. Secrets are supplied to
`security` over stdin, never process arguments, returned tool data or logs. Runtime
reads that item into the MCP process only. It does not reuse or modify Casamia's
credentials. No `.env` values are required.

Nonsecret selection is atomically saved, mode `0600`, at:

```text
~/Library/Application Support/mac-apps-mcp/invitations/calendar.json
```

The directory is mode `0700`. Setup refuses to overwrite an existing selection.
A failed setup can leave an unused Keychain item; it does not activate an incomplete
selection. Resolve it locally with Keychain Access. Account/calendar replacement
requires owner intervention after reconciling outstanding operations. Never remove
operation records as a retry mechanism. Keep this capability on one executing Mac;
its operation directory is not a distributed ledger for multiple Macs.

## MCP contract

`calendar_invitation_check` takes `{}` and returns `ready`, `calendar`,
`calendarUrl`, `organizer` and `liveDeliveryVerified: false`. The last field means
preflight is not a live delivery test. No credentials or credential identifiers
are returned. Use this exact calendar URL; calendar names are not unique identities.

`calendar_send_invitation` requires all the fields below. Empty `location` and
`description` are allowed; neither is silently inferred. Whole-second timestamps
must include `Z` or a numeric offset and end must follow start. Recurring and
all-day invitations are outside this contract.

```json
{
  "operationId": "cd917617-b25a-4e1e-95b5-5e905aa29e23",
  "calendar": "Fictional Personal",
  "calendarUrl": "https://p01-caldav.icloud.com/fictional/calendars/personal/",
  "organizer": "alex@example.com",
  "attendees": ["blair@example.net"],
  "title": "Coffee",
  "start": "2027-06-08T10:00:00-07:00",
  "end": "2027-06-08T11:00:00-07:00",
  "location": "Fictional cafe",
  "description": "Discuss our walking plans.",
  "confirm": true
}
```

The configured calendar name, URL and organizer must match exactly. Attendees
must be distinct bare email addresses, excluding the organizer (maximum 20).
Mailbox comparison on read-back is case-insensitive; the operation digest binds
all exact input strings, including offsets and attendee order. UTC serialization
preserves the approved instants, while the caller retains the original offsets.
The event is opaque/busy. No implicit duration, extra recipient, reminder or policy
is introduced.

`calendar_get_invitation` takes the same exact fields except `confirm`, including
the original operation ID. It only GETs the deterministic resource, compares actual
fields and attendees, and reports current scheduling and participation. Use it
for timeout reconciliation and later acceptance checks; there is no background poll.

Controls:

- `MACOS_MCP_READONLY=true|1` omits send and blocks writes again at execution time.
  Check and read-back remain available.
- `MACOS_MCP_CONFIRM_DESTRUCTIVE=true|1` requires `confirm: true` before the tool
  accesses credentials or transport. This is the existing MCP confirmation control,
  not a substitute for caller-side exact approval.
- `MACOS_MCP_CALENDARS` restricts the selected calendar by its configured name.
- `MACOS_MCP_ALLOWED_RECIPIENTS` also restricts invitation attendees.
- Existing Calendar app permissions do not grant CalDAV credentials. The separate
  owner setup is required. `MACOS_MCP_SEND_AS_DRAFT` is mail-only; invitations have
  no draft-send mode. Use check for preflight.

## Retry and result semantics

The caller persists one UUID with each approved proposal before executing it.
A deterministic UID and resource path derive from that ID. Before any PUT, MCP
atomically reserves the ID with a SHA-256 digest of every exact invitation field
in its private `operations/` directory and fsyncs it. Concurrent callers see a
complete digest. Changed payloads under the same ID are rejected, including a
changed calendar after reconfiguration.

A first call verifies preflight, reserves the ID and GETs the resource. Only an
initial 404 on that first reservation permits one PUT with `If-None-Match: *`.
Every subsequent call uses GET only. A timeout or HTTP failure gets one read-back,
never another PUT. Even a crash before PUT or a later deleted/missing event does
not permit another send. This conservative choice prevents an ambiguous operation
from turning into a second invitation; it can require owner reconciliation of an
operation that never reached the server. Do not switch Macs, clear the ledger or
create a fresh ID to bypass it. Preserve the ledger with the MCP's local state.

Results contain `operationId`, `uid`, `resourceUrl`, `reused`, `state`, `recipients`
and a message. When a PUT response was received, `writeResponseStatus` records
its HTTP code, including refusals; it is not evidence of delivery.

- `state: stored`: read-back verified exactly one noncancelled, nonrecurring event,
  its organizer, times, text and attendee set. `event` contains the parsed actual
  fields (UTC timestamps). The calendar identity is the exact GET target.
- `state: outcome_unknown`: the resource is absent, unreadable, mismatched or
  otherwise unverified. Do not send again. Reconcile with the original ID.
  An HTTP refusal is preserved when available but never converted into delivery.
- Errors before sending include invalid input, excluded calendars/recipients,
  unsupported scheduling, wrong ownership, unavailable credentials and changed
  payload under an existing ID. They never authorize a fresh retry identity.

Each recipient has the server's `scheduleStatus` codes, a conservative `scheduling`
interpretation, and `participation`. Missing/unrecognized values are `unknown`.
`1.0` is pending, `1.1` is sent with delivery unknown, `1.2` is server-reported
delivery, and `2.0` is success with delivery unknown. Codes starting 3, 4 or 5 report
failure. Participation is independent: `NEEDS-ACTION`, `ACCEPTED`, `DECLINED`,
`TENTATIVE`, `DELEGATED` or unknown. Stored state, HTTP success and server-reported
delivery never imply acceptance or independently verified recipient receipt.

## Casamia boundary and live acceptance

Casamia retains relationship judgment, household access policy, exact user approval,
orchestration and outcome tracking. After checking the MCP selection, it should
register the exact proposal, persist the operation UUID with its approval, and call
send only after consuming that exact approval. It must map fields explicitly
(`recipients` to `attendees`, `notes` to `description`) and retain the MCP receipt.
A repeated execution uses the same UUID and unchanged payload; unknown outcomes
must use read-back. Keep credentials on the MCP Mac and do not run both transports
for one approved action. This change does not migrate or enable Casamia.

Fictional tests cover transport, ownership/privileges, exact fields, offsets,
duplicate convergence, changed payloads, failures, read-back and MCP controls.
They do not validate Apple's live account behavior or Keychain prompts.

Remaining acceptance requires owner setup/check and **one separately approved**
invitation with exact recipients and fields. Verify the chosen calendar, actual
recipient receipt and participation evidence. Record only aggregate evidence in
GitHub. Do not merge, publish, deploy, change credentials or send a live invitation
as part of code review. No live setup, invitation or recipient acceptance has been
performed by the implementation agent.
