/**
 * Apple Contacts (Address Book) MCP tools.
 *
 * Read operations query the AddressBook SQLite database directly for
 * instant results. All access is read-only.
 *
 * Provides: listContacts, getContact, searchContacts
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import { sqliteQuery, sqlEscape, sqlLikeEscape, safeInt } from "../shared/sqlite.js";
import { PaginatedResult, paginateRows, fromCoreDataTimestamp } from "../shared/types.js";

// ─── Database Detection ──────────────────────────────────────────

const ADDRESSBOOK_BASE = join(
  homedir(),
  "Library/Application Support/AddressBook"
);

/**
 * Find the AddressBook database with the most data.
 * macOS stores contacts across multiple Source databases (iCloud, Exchange,
 * local, etc.) under AddressBook/Sources/{UUID}/. We pick the largest
 * database, which typically contains the primary iCloud-synced contacts.
 *
 * Note: This heuristic could miss contacts from smaller secondary sources.
 * A future enhancement could query all sources and deduplicate.
 */
function findContactsDb(): string {
  const sourcesDir = join(ADDRESSBOOK_BASE, "Sources");
  if (!existsSync(sourcesDir)) {
    throw new Error(
      `Contacts database not found: ${sourcesDir}. ` +
      "Open Contacts.app once to initialize the database."
    );
  }

  let bestPath = "";
  let bestSize = 0;

  for (const src of readdirSync(sourcesDir)) {
    const srcDir = join(sourcesDir, src);
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch { /* skip non-statable entries */ continue; }

    // Search for AddressBook-v*.abcddb (version may change with macOS updates)
    try {
      for (const f of readdirSync(srcDir)) {
        if (/^AddressBook-v\d+\.abcddb$/.test(f)) {
          const dbPath = join(srcDir, f);
          try {
            const { size } = statSync(dbPath);
            if (size > bestSize) {
              bestSize = size;
              bestPath = dbPath;
            }
          } catch { /* skip inaccessible db files */ }
        }
      }
    } catch (e) {
      process.stderr.write(`[contacts] Skipping unreadable source dir ${src}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  if (!bestPath) {
    throw new Error(
      "No AddressBook database found. Ensure Contacts.app has been opened " +
      "and Full Disk Access is granted."
    );
  }

  return bestPath;
}

let _contactsDb: string | null = null;
let _contactsDbExpiry = 0;
const DB_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getContactsDb(): string {
  if (!_contactsDb || Date.now() > _contactsDbExpiry) {
    _contactsDb = findContactsDb();
    _contactsDbExpiry = Date.now() + DB_CACHE_TTL_MS;
  }
  return _contactsDb;
}

// ─── Types ───────────────────────────────────────────────────────

export interface ContactSummary {
  id: string;
  firstName: string;
  lastName: string;
  organization: string;
  jobTitle: string;
  email: string;
  phone: string;
}

export interface ContactFull extends ContactSummary {
  middleName: string;
  nickname: string;
  department: string;
  title: string;
  suffix: string;
  birthday: string;
  emails: { address: string; label: string }[];
  phones: { number: string; label: string }[];
  addresses: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    label: string;
  }[];
  note: string;
}

// PaginatedResult<T> imported from shared/types.ts
export type { PaginatedResult } from "../shared/types.js";

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Parse macOS address book label format.
 * Apple stores labels like "_$!<Home>!$_" — we extract the inner text.
 */
export function parseLabel(raw: string | null): string {
  if (!raw) return "";
  const match = raw.match(/_\$!<(.+?)>!\$_/);
  return match ? match[1] : raw;
}

// ─── Read Tools (SQLite — instant) ──────────────────────────────

/**
 * List or search contacts with pagination.
 * Optional query searches first name, last name, and organization.
 */
export async function listContacts(
  query?: string,
  limit = 50,
  offset = 0
): Promise<PaginatedResult<ContactSummary>> {
  const db = getContactsDb();

  let whereSql = "r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL";
  if (query) {
    const safe = sqlLikeEscape(query.toLowerCase());
    whereSql = `(
      LOWER(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'')) LIKE '%${safe}%' ESCAPE '\\'
      OR LOWER(COALESCE(r.ZORGANIZATION,'')) LIKE '%${safe}%' ESCAPE '\\'
    )`;
  }

  const [rows, countRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT r.ZUNIQUEID, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, r.ZJOBTITLE,
         (SELECT e.ZADDRESS FROM ZABCDEMAILADDRESS e WHERE e.ZOWNER = r.Z_PK ORDER BY e.ZORDERINGINDEX LIMIT 1) as email,
         (SELECT p.ZFULLNUMBER FROM ZABCDPHONENUMBER p WHERE p.ZOWNER = r.Z_PK ORDER BY p.ZORDERINGINDEX LIMIT 1) as phone
       FROM ZABCDRECORD r
       WHERE (${whereSql})
       ORDER BY COALESCE(r.ZSORTINGFIRSTNAME, r.ZFIRSTNAME, ''), COALESCE(r.ZSORTINGLASTNAME, r.ZLASTNAME, '')
       LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`
    ),
    sqliteQuery(
      db,
      `SELECT COUNT(*) as total FROM ZABCDRECORD r WHERE (${whereSql});`
    ),
  ]);

  const total = safeInt(countRows[0]?.total ?? 0);

  const items: ContactSummary[] = rows.map((r) => ({
    id: String(r.ZUNIQUEID || ""),
    firstName: String(r.ZFIRSTNAME || ""),
    lastName: String(r.ZLASTNAME || ""),
    organization: String(r.ZORGANIZATION || ""),
    jobTitle: String(r.ZJOBTITLE || ""),
    email: String(r.email || ""),
    phone: String(r.phone || ""),
  }));

  return paginateRows(items, total, offset);
}

/**
 * Get full details for a specific contact by unique ID.
 */
export async function getContact(contactId: string): Promise<ContactFull> {
  const db = getContactsDb();
  const safeId = sqlEscape(contactId);

  const rows = await sqliteQuery(
    db,
    `SELECT r.Z_PK, r.ZUNIQUEID, r.ZFIRSTNAME, r.ZLASTNAME, r.ZMIDDLENAME,
       r.ZORGANIZATION, r.ZJOBTITLE, r.ZDEPARTMENT, r.ZNICKNAME,
       r.ZTITLE, r.ZSUFFIX, r.ZBIRTHDAY
     FROM ZABCDRECORD r
     WHERE r.ZUNIQUEID = '${safeId}'
     LIMIT 1;`
  );

  if (!rows.length) throw new Error("Contact not found");
  const r = rows[0];
  const pk = safeInt(r.Z_PK);

  // Fetch related data in parallel
  const [emailRows, phoneRows, addressRows, noteRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT ZADDRESS, ZLABEL FROM ZABCDEMAILADDRESS
       WHERE ZOWNER = ${pk} ORDER BY ZORDERINGINDEX;`
    ),
    sqliteQuery(
      db,
      `SELECT ZFULLNUMBER, ZLABEL FROM ZABCDPHONENUMBER
       WHERE ZOWNER = ${pk} ORDER BY ZORDERINGINDEX;`
    ),
    sqliteQuery(
      db,
      `SELECT ZSTREET, ZCITY, ZSTATE, ZZIPCODE, ZCOUNTRYNAME, ZLABEL
       FROM ZABCDPOSTALADDRESS
       WHERE ZOWNER = ${pk} ORDER BY ZORDERINGINDEX;`
    ),
    sqliteQuery(
      db,
      `SELECT ZTEXT FROM ZABCDNOTE
       WHERE ZCONTACT = ${pk} LIMIT 1;`
    ),
  ]);

  const emails = emailRows.map((e) => ({
    address: String(e.ZADDRESS || ""),
    label: parseLabel(String(e.ZLABEL || "")),
  }));

  const phones = phoneRows.map((p) => ({
    number: String(p.ZFULLNUMBER || ""),
    label: parseLabel(String(p.ZLABEL || "")),
  }));

  const addresses = addressRows.map((a) => ({
    street: String(a.ZSTREET || ""),
    city: String(a.ZCITY || ""),
    state: String(a.ZSTATE || ""),
    zip: String(a.ZZIPCODE || ""),
    country: String(a.ZCOUNTRYNAME || ""),
    label: parseLabel(String(a.ZLABEL || "")),
  }));

  return {
    id: String(r.ZUNIQUEID || ""),
    firstName: String(r.ZFIRSTNAME || ""),
    lastName: String(r.ZLASTNAME || ""),
    middleName: String(r.ZMIDDLENAME || ""),
    organization: String(r.ZORGANIZATION || ""),
    jobTitle: String(r.ZJOBTITLE || ""),
    department: String(r.ZDEPARTMENT || ""),
    nickname: String(r.ZNICKNAME || ""),
    title: String(r.ZTITLE || ""),
    suffix: String(r.ZSUFFIX || ""),
    birthday: fromCoreDataTimestamp(r.ZBIRTHDAY),
    email: emails[0]?.address || "",
    phone: phones[0]?.number || "",
    emails,
    phones,
    addresses,
    note: String(noteRows[0]?.ZTEXT || ""),
  };
}

/**
 * Search contacts by specific scope: name, email, phone, or organization.
 */
export async function searchContacts(
  query: string,
  scope: "all" | "name" | "email" | "phone" | "organization" = "all",
  limit = 20,
  offset = 0
): Promise<PaginatedResult<ContactSummary>> {
  const db = getContactsDb();
  const safe = sqlLikeEscape(query.toLowerCase());

  let joinSql = "";
  let scopeSql: string;

  switch (scope) {
    case "name":
      scopeSql = `LOWER(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'')) LIKE '%${safe}%' ESCAPE '\\'`;
      break;
    case "email":
      joinSql = "JOIN ZABCDEMAILADDRESS e ON r.Z_PK = e.ZOWNER";
      scopeSql = `LOWER(e.ZADDRESS) LIKE '%${safe}%' ESCAPE '\\'`;
      break;
    case "phone":
      joinSql = "JOIN ZABCDPHONENUMBER p ON r.Z_PK = p.ZOWNER";
      scopeSql = `LOWER(p.ZFULLNUMBER) LIKE '%${safe}%' ESCAPE '\\'`;
      break;
    case "organization":
      scopeSql = `LOWER(COALESCE(r.ZORGANIZATION,'')) LIKE '%${safe}%' ESCAPE '\\'`;
      break;
    default: // all
      scopeSql = `(
        LOWER(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,'')) LIKE '%${safe}%' ESCAPE '\\'
        OR LOWER(COALESCE(r.ZORGANIZATION,'')) LIKE '%${safe}%' ESCAPE '\\'
        OR r.Z_PK IN (SELECT e2.ZOWNER FROM ZABCDEMAILADDRESS e2 WHERE LOWER(e2.ZADDRESS) LIKE '%${safe}%' ESCAPE '\\')
        OR r.Z_PK IN (SELECT p2.ZOWNER FROM ZABCDPHONENUMBER p2 WHERE LOWER(p2.ZFULLNUMBER) LIKE '%${safe}%' ESCAPE '\\')
      )`;
      break;
  }

  // Use DISTINCT to avoid duplicates when joining multi-value tables
  const distinctPrefix = joinSql ? "DISTINCT " : "";

  const [rows, countRows] = await Promise.all([
    sqliteQuery(
      db,
      `SELECT ${distinctPrefix}r.ZUNIQUEID, r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, r.ZJOBTITLE,
         (SELECT e3.ZADDRESS FROM ZABCDEMAILADDRESS e3 WHERE e3.ZOWNER = r.Z_PK ORDER BY e3.ZORDERINGINDEX LIMIT 1) as email,
         (SELECT p3.ZFULLNUMBER FROM ZABCDPHONENUMBER p3 WHERE p3.ZOWNER = r.Z_PK ORDER BY p3.ZORDERINGINDEX LIMIT 1) as phone
       FROM ZABCDRECORD r
       ${joinSql}
       WHERE ${scopeSql}
       ORDER BY COALESCE(r.ZSORTINGFIRSTNAME, r.ZFIRSTNAME, ''), COALESCE(r.ZSORTINGLASTNAME, r.ZLASTNAME, '')
       LIMIT ${safeInt(limit)} OFFSET ${safeInt(offset)};`
    ),
    sqliteQuery(
      db,
      `SELECT COUNT(${distinctPrefix}r.ZUNIQUEID) as total
       FROM ZABCDRECORD r
       ${joinSql}
       WHERE ${scopeSql};`
    ),
  ]);

  const total = safeInt(countRows[0]?.total ?? 0);

  const items: ContactSummary[] = rows.map((r) => ({
    id: String(r.ZUNIQUEID || ""),
    firstName: String(r.ZFIRSTNAME || ""),
    lastName: String(r.ZLASTNAME || ""),
    organization: String(r.ZORGANIZATION || ""),
    jobTitle: String(r.ZJOBTITLE || ""),
    email: String(r.email || ""),
    phone: String(r.phone || ""),
  }));

  return paginateRows(items, total, offset);
}
