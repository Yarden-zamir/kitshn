// Schemas for input that crosses the wire. The UI imports only model.ts, so effect stays out of its bundle.
import { Schema } from "effect";
import type { Edit, Author } from "./changes.ts";
import * as Model from "./model.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -1e6, maximum: 1e6 }));
const Time = Schema.Finite;

export const Level = Schema.Literals(Model.LEVELS);

/** K-1754: the conditions of an agent actor on attested labels. */
const Conditions = Schema.Array(
  Schema.Struct({
    key: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(64)),
    values: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
  }),
).check(Schema.isMaxLength(10));
/** K-1720: the mode of one effect. */
const RightMode = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("automatic") }),
  Schema.Struct({ mode: Schema.Literal("ask"), circleId: Id }),
  Schema.Struct({ mode: Schema.Literal("off") }),
]);
/** K-1730, K-1776: the mode of each effect of an actor in a circle; a missing effect takes its default. */
const Rights = Schema.Struct({
  reads: Schema.optionalKey(RightMode),
  maintains: Schema.optionalKey(RightMode),
  creates: Schema.optionalKey(RightMode),
  changes: Schema.optionalKey(RightMode),
  runs: Schema.optionalKey(RightMode),
  destroys: Schema.optionalKey(RightMode),
  shares: Schema.optionalKey(RightMode),
  secrets: Schema.optionalKey(RightMode),
});
// A new effect of EFFECTS fails here until the schema decodes it.
const _everyEffect: Record<Model.Effect, unknown> = Rights.fields;

const Email = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/));

/** K-1778: the credentials of an actor. */
export const Credential = Schema.Union([
  Schema.TaggedStruct("login", { email: Email }),
  Schema.TaggedStruct("token", { tokenId: Schema.String, clientId: Schema.String, name: Name }),
  Schema.TaggedStruct("machine", { machineId: Id }),
]);

export const Actor = Schema.Struct({
  id: Id,
  name: Name,
  credentials: Schema.Array(Credential).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  conditions: Schema.optionalKey(Conditions),
});

export const Member = Schema.Union([
  Schema.TaggedStruct("actor", { actorId: Id, rights: Schema.optionalKey(Rights) }),
  Schema.TaggedStruct("domain", {
    domain: Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+\.[a-z]{2,}$/)),
  }),
  Schema.TaggedStruct("ip", { range: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F:.]+\/\d{1,3}$/)) }),
  Schema.TaggedStruct("everyone", {}),
]);

export const Circle = Schema.Struct({
  id: Id,
  name: Name,
  color: Schema.String.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/)),
  level: Level,
  members: Schema.Array(Member).check(Schema.isMaxLength(200)),
  match: Schema.Literals(["any", "all"]),
  needsPasskey: Schema.Boolean,
  approvesWithoutPasskey: Schema.optionalKey(Schema.Boolean),
  endsAt: Schema.NullOr(Time),
  x: Coordinate,
  y: Coordinate,
  r: Schema.Finite.check(Schema.isBetween({ minimum: 40, maximum: 1e5 })),
});

export const Point = Schema.Struct({ x: Coordinate, y: Coordinate });

export const ShareSetting = Schema.Struct({ level: Schema.NullOr(Level), endsAt: Schema.NullOr(Time) });

export const Edit_ = Schema.Union([
  Schema.TaggedStruct("circle", { id: Schema.String, after: Schema.NullOr(Circle) }),
  Schema.TaggedStruct("actor", { id: Schema.String, after: Schema.NullOr(Actor) }),
  Schema.TaggedStruct("place", { id: Schema.String, after: Schema.NullOr(Point) }),
  Schema.TaggedStruct("cardEnd", { id: Schema.String, after: Schema.NullOr(Time) }),
  Schema.TaggedStruct("shareSetting", {
    resourceId: Schema.String,
    circleId: Schema.String,
    after: Schema.NullOr(ShareSetting),
  }),
  Schema.TaggedStruct("pause", { after: Schema.NullOr(Schema.Literals(["keep-public", "lockdown"])) }),
  Schema.TaggedStruct("stack", {
    id: Schema.String,
    after: Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(80)),
        members: Schema.Array(Schema.String).check(Schema.isMaxLength(200)),
      }),
    ),
  }),
]);

export const Author_ = Schema.Union([
  Schema.TaggedStruct("person", { email: Schema.String }),
  Schema.TaggedStruct("device", { clientId: Schema.String, name: Schema.String }),
  Schema.TaggedStruct("machine", { machineId: Schema.String, name: Schema.String }),
  Schema.TaggedStruct("kitshn", { reason: Schema.String }),
]);

/** K-532: a size that the map measured, in map units. */
const Drawn = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e5 }));
const DrawnSize = Schema.Struct({ id: Schema.String, width: Drawn, height: Drawn });

/** Messages from a map client, over the WebSocket or as a POST body. */
export const ClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("apply"),
    requestId: Schema.String,
    edits: Schema.Array(Edit_).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  Schema.Struct({
    type: Schema.Literal("undo"),
    requestId: Schema.String,
    revision: Schema.Int,
    source: Schema.optional(Schema.Literals(Model.UNDO_SOURCES)),
  }),
  Schema.Struct({
    type: Schema.Literal("undoItem"),
    requestId: Schema.String,
    item: Schema.Struct({ kind: Schema.Literals(["card", "circle"]), id: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("organize"),
    requestId: Schema.String,
    /** The drawn box of each card or stack around the place of its first card. */
    units: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        left: Coordinate,
        top: Coordinate,
        right: Coordinate,
        bottom: Coordinate,
      }),
    ).check(Schema.isMaxLength(5000)),
    heads: Schema.Array(DrawnSize).check(Schema.isMaxLength(1000)),
    members: Schema.Array(DrawnSize).check(Schema.isMaxLength(1000)),
    /** The kinds that the map hides, also kinds of providers (K-704); their cards stay where they are. */
    hiddenKinds: Schema.Array(Schema.String.check(Schema.isMaxLength(80))).check(Schema.isMaxLength(200)),
  }),
]);
export type ClientMessage = typeof ClientMessage.Type;

/** K-1801: a search in the logs view, as the body of `POST /api/apps/<card>/logs`. */
export const LogQuery = Schema.Struct({
  tab: Schema.Literals(["app", "deploys"]),
  text: Schema.String.check(Schema.isMaxLength(200)),
  from: Time,
  to: Time,
});

/** K-1805, K-1807: "Live" in the logs view starts and stops a tail over the map's WebSocket. */
export const TailMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("tail"), requestId: Schema.String, card: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tailStop"), tail: Schema.String }),
]);
export type TailMessage = typeof TailMessage.Type;

// The schemas and the model types must describe the same values.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const agree = <T extends true>(_: T) => _;
agree<Same<typeof Member.Type, Model.Member>>(true);
agree<Same<typeof Circle.Type, Model.Circle>>(true);
agree<Same<typeof Actor.Type, Model.Actor>>(true);
agree<Same<typeof Point.Type, Model.Point>>(true);
agree<Same<typeof ShareSetting.Type, Model.ShareSetting>>(true);
agree<Same<typeof Edit_.Type, Edit>>(true);
agree<Same<typeof Author_.Type, Author>>(true);
