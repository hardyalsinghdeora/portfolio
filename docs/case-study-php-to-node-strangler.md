# Replacing a live PHP application with Node.js and Angular, without users noticing

**Type:** decision record · **Role:** designed and led · **When:** 2020–2024, as Lead Software Engineer · **Status:** complete, legacy application retired

Names, schemas and figures are kept private. This record covers the architecture and the order of moves.

## Context

A live web application ran on PHP with MySQL. Login and sessions lived in PHP. The goal was to move it to Node.js APIs on PostgreSQL with an Angular front end, and to retire the PHP application. A rewrite-and-switch was ruled out: users had to keep working throughout, and they should not be able to tell a migration was happening.

## The approach: a strangler migration with a shared login

The new application grew around the old one, page by page, until nothing was left in the old one to switch off.

**1. One login, two applications.**
- Login stayed in PHP and MySQL, exactly where users already had it.
- At login, the system also issued a **JWT** for the migrated application, which ran on Node.js and PostgreSQL.
- Logout destroyed **both** the PHP session and the JWT, so a user was never half signed in.
- From the user's side there was still one application and one session.

**2. Move the internal pages first, behind the existing UI.**
The pages behind the login were moved onto Node.js APIs one at a time, invisibly to users.

**3. Keep both databases current with two data layers.**
- A **PostgreSQL data layer was added to the legacy PHP code**.
- A **MySQL data layer was added to the new Node.js APIs**.
- Whichever application handled a request, both databases stayed current.
- So both applications could run in parallel on live traffic, and either side could serve any page during the transition.

**4. Rebuild the UI once the APIs carried every operation.**
Only when all operations ran through the Node.js APIs did the Angular UI get built on top of them.

**5. Freeze the legacy side.**
From that point, every new enhancement went into Node.js and Angular only. The PHP code stopped growing, which kept the remaining migration finite.

**6. Retire the legacy application.**
With all traffic and all features on the new stack, the PHP application was switched off.

## Why this order

- **Auth first.** A shared session is the precondition for moving anything else page by page. Without it, every move would show the user a seam: a second login, or a lost session.
- **APIs before UI.** Rebuilding the UI on half-migrated back ends means building it twice. Moving the operations first means the Angular UI was built once, against the final APIs.
- **Freezing legacy features** is what turns a parallel run into a migration with an end date.

## Trade-offs accepted

- **Dual data layers in application code.** Keeping two databases current from both codebases works for a bounded transition, but it relies on every write path being covered. That cost is acceptable only because the parallel run has an end.
- **Coupled logout.** Session teardown has to cover both mechanisms every time. It is a small piece of code with a large blast radius if it is missed.

## Outcome

- The application moved from PHP and MySQL to Node.js, Angular and PostgreSQL.
- Users saw no interruption throughout.
- The legacy PHP application is fully retired.

## Related

A later, separate project, moving a live commerce platform from MySQL to PostgreSQL, made a different call on dual writes. It used a one-time backfill plus a continuous reverse sync, with reconciliation built into the mechanism. See [the migration case study](https://github.com/hardyalsinghdeora/case-studies/blob/main/migration-live-commerce-platform.md).
