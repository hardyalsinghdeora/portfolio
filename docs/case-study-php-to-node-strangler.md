# Replacing a live PHP application with Node.js microservices and Angular, without users noticing

**Type:** decision record · **Role:** designed and led, with a team of 2 developers · **When:** 2020–2024, as Lead Software Engineer · **Status:** complete, legacy application retired

| 70 | 12 | 3 months | 2 + me |
|---|---|---|---|
| pages migrated | modules | from start to legacy retired | developers, led by me |

Internal names and schemas are kept private. This record covers the architecture, the order of moves and why.

## Context

The school-facing application ran on PHP with MySQL, with login and sessions in PHP. It had to move to a **microservice architecture on Node.js and PostgreSQL with an Angular front end**, and the PHP application had to be retired. Schools had to keep working throughout and should not be able to tell a migration was happening.

## The constraint that shaped everything

The MySQL database this application writes to is **the centre of every product sold to schools**. Other products read from it every day.

That rules out the obvious plan, a new application plus a one-time database migration. Moving this application's data off MySQL in one go would have forced every other product to migrate at the same time, which wasn't possible.

**So the design had to support both databases and both applications at once.** The application would move platform by platform, while MySQL stayed complete and current for everything else that depends on it.

## The approach

**1. Build the APIs first, as microservices, and call them from PHP.**
- Microservice APIs on Node.js and PostgreSQL were built for all 12 modules up front.
- The live PHP application called these APIs **after every event**, so PostgreSQL stayed current from day one.
- Users kept using PHP and MySQL exactly as before.

**2. A MySQL data layer in every API, behind a per-module flag.**
- Each API also got a MySQL data layer, switched on or off per module:
  - **Flag off:** the module still runs in PHP, and PHP writes MySQL itself, so the API must not write it as well.
  - **Flag on:** the module has moved to Node.js, so the API writes MySQL, and every product that reads MySQL keeps working.
- Moving a module meant flipping one flag, not running a data migration.

**3. One login, two applications.**
- Login stayed in PHP and MySQL.
- At login the system also issued a **JWT** for the migrated application.
- Logout destroyed **both** the PHP session and the JWT, so users always saw one application and one session.

**4. Move the pages, keep the UI.**
- The 70 pages moved to Node.js APIs and Angular one module at a time.
- The Angular UI **deliberately kept the existing look**, so users noticed nothing.
- What changed underneath is that the UI can now be updated centrally, through shared Angular components, rather than page by page in PHP.

**5. New work only on the new stack.**
Every new enhancement went into Node.js and Angular, never into PHP. That kept the migration finite.

**6. Retire PHP, keep MySQL in sync.**
- With all 12 modules on the new stack, the MySQL flag is **on for every module** and the PHP application was switched off.
- The flags stay on until every product that reads MySQL has moved to PostgreSQL. At that point, MySQL can be retired too.

## Why this order

- **APIs before pages.** With PHP calling the APIs on every event, PostgreSQL was proven against live traffic before any user-facing page depended on it.
- **The per-module flag is the cutover.** Each module's switch from PHP to Node.js was a configuration change, not a data migration.
- **Same UI, new framework.** Changing the stack and the design at the same time would have made every issue look like a migration issue. Keeping the UI identical isolated the risk to the platform move.

## Trade-offs accepted

- **Writes to two databases from application code.** The design relies on every write path being covered, either by PHP for modules still in PHP, or by the API's MySQL layer once the flag is on. That's acceptable because MySQL has to stay current anyway while other products depend on it.
- **Coupled logout.** Session teardown has to cover both mechanisms every time.

## Outcome

- **70 pages across 12 modules** moved from PHP to Node.js microservices, PostgreSQL and Angular in **3 months**, with **2 developers** led by me.
- Users saw **no interruption**, and the UI looked the same throughout.
- The legacy PHP application is **fully retired**. MySQL stays current through the flags until the remaining products move to PostgreSQL.

## Related

A separate, later project took on a related problem: a live MySQL → PostgreSQL migration of the commerce platform across six product lines, using a one-time backfill plus a continuous reverse sync. See [that case study](https://github.com/hardyalsinghdeora/case-studies/blob/main/migration-live-commerce-platform.md).
