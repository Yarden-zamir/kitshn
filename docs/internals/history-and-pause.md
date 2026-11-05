# History, Undo and the pause

Every change is a revision, Undo reverses a revision, and the pause closes access at once. This file holds those rules (K-15xx).

## History and Undo

- **K-1501** Every change makes one revision with the time, the actor (owner device, agent with machine and thread, or kitshn for an expiry) and a summary. A move that joins the newest revision (K-1505) changes that revision instead.
- **K-1502** "Undo" makes a new revision that reverses a revision, by the rules of K-1506. Undo of an undo reverses it again. Undo runs the guard of K-105 and the pause check of K-1504. The undo of an app removal also starts the app again (K-909).
- **K-1503** The daily alarm deletes revisions older than 90 days and beyond the newest 5,000.
- **K-1505** A move joins the revision of the move or drop that started it, when that revision is of the same items, by the same actor, and at most 2 minutes old. Two minutes covers the nudges after a drop. When a move changes a share, the summary is the net summary of the whole revision, because History is the record of who gave access. The server commit does this, so the map, `/api/apply` and agent tools behave the same. An Organize (K-532) joins nothing. Known limit: any other revision in between starts a new entry. Revisit when drops and their moves split on a busy map.
- **K-1506** Undo reverses the caller's own newest revision that changes something, as a whole. The rule is per actor because other actors write often: on the live map, about half of the revisions come from devices, deploys and live site reports. kitshn refuses an Undo when a later revision by anyone touches the same card, or changes a circle that a card of the revision is or was inside. This keeps an undo from giving access that a later change made possible. A revision that forgets a card marks it, so an older undo never touches a new card with the same id. Known limit: a later revocation of the same member through another circle does not block the undo. Revisit when circles often share members.
- **K-1507** "Undo last change to this card" (or circle) undoes only that item's part of the caller's own newest revision that changed it: `POST /api/undo-item`. The rules of K-1506 hold for the item's part. kitshn refuses it when the rest of the revision depends on the item's part. `GET /api/undo-item` answers with the same rule, so the menu and the undo agree. Only a member with control on the admin card calls it. Agent keys have no undo (K-718).
- **K-1508** History groups the revisions by day and by runs of one actor. Each row starts with the verb from the summary alone, so a row never adds a fact. Filters: the kind of change, the actor, and words. Only the caller's own newest revision shows Undo, after `GET /api/undo?revision=<id>` allows it. A click on a row pans the map to its cards and circles, so each snapshot revision carries at most 30 changed items.
- **K-1509** Each whole-revision Undo records where it came from: the toast, History, or the HTTP API. The History row of the undo says it, so an Undo that the owner did not mean shows how it came.

## Emergency pause

- **K-1504** "Emergency pause" is a big red button under a flip-up lid. One press pauses at once, with no confirm, because a pause only lowers access and Resume undoes it. The lid is part of the button, not a confirm. Rules:
  - The pause moves no card. It keeps the admin share of the Owner circle for its people, and the shares of public circles on sites, pages and files, so public sites stay up. "Close public sites too" makes it a lockdown, which closes those too.
  - It closes every other share, and every share of tokens and machines, so agents stop moving, deploying and running jobs. It denies every open agent proposal and revokes every GitHub token that kitshn holds (K-1716).
  - New deploys from GitHub wait until Resume. A preview teardown still runs.
  - It sends "stop all agents" to every provider that has the command.
  - Pages and files close at once. Access applications close through the alarm queue (K-406), so many applications take a few alarm runs. Machines stay connected, and their apps run behind closed doors.
  - While paused, any change that raises access is refused. Lowering access still works.
  - Every view shows a banner with the kind of pause, who paused and when, and Resume.
  - Resume needs a fresh passkey: the owner passes the check of the `/api/fresh` application, with an MFA session of ten minutes, and only that path ends the pause. Only owner emails of the bootstrap that are also in the Owner circle can Resume. An edit or an undo never does. VERIFY: the ten-minute MFA session asks for the passkey again after the 24-hour admin login.
  - The press plays a thunk at once, and the klaxon, flash and stamp only when the press made a new pause. A pause from another device plays nothing.
