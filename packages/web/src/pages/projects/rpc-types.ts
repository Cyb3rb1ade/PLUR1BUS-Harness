// Wire types of the RPC methods the Projects page uses (docs/projects-board.md, packages/rpc-schema).
// Types are imported strictly from packages/rpc-schema/generated/types.ts without handwritten definitions.
import type {
  BoardActor,
  BoardCard,
  BoardColumn,
  BoardComment,
  BoardActivity,
  BoardLink,
  ProjectColumnCreateParams,
  ProjectColumnDeleteParams,
  ProjectColumnDeleteResult,
  ProjectColumnListParams,
  ProjectColumnListResult,
  ProjectColumnMoveParams,
  ProjectColumnUpdateParams,
  ProjectCardActivityListParams,
  ProjectCardActivityListResult,
  ProjectCardArchiveParams,
  ProjectCardAssignParams,
  ProjectCardCommentAddParams,
  ProjectCardCommentListParams,
  ProjectCardCommentListResult,
  ProjectCardCreateParams,
  ProjectCardGetParams,
  ProjectCardListParams,
  ProjectCardListResult,
  ProjectCardMoveParams,
  ProjectCardUnarchiveParams,
  ProjectCardUnassignParams,
  ProjectCardUpdateParams,
} from "../../../../rpc-schema/generated/types.ts";
import type { Project } from "../surfaces/data.ts";

export type {
  BoardActor,
  BoardCard,
  BoardColumn,
  BoardComment,
  BoardActivity,
  BoardLink,
  ProjectColumnCreateParams,
  ProjectColumnDeleteParams,
  ProjectColumnDeleteResult,
  ProjectColumnListParams,
  ProjectColumnListResult,
  ProjectColumnMoveParams,
  ProjectColumnUpdateParams,
  ProjectCardActivityListParams,
  ProjectCardActivityListResult,
  ProjectCardArchiveParams,
  ProjectCardAssignParams,
  ProjectCardCommentAddParams,
  ProjectCardCommentListParams,
  ProjectCardCommentListResult,
  ProjectCardCreateParams,
  ProjectCardGetParams,
  ProjectCardListParams,
  ProjectCardListResult,
  ProjectCardMoveParams,
  ProjectCardUnarchiveParams,
  ProjectCardUnassignParams,
  ProjectCardUpdateParams,
  Project,
};

declare module "../../api/index.ts" {
  interface RpcMethods {
    "project.list": { params: Record<string, never>; result: { projects: Project[] } };
    "project.create": { params: { name: string }; result: Project };
    "project.column.list": { params: ProjectColumnListParams; result: ProjectColumnListResult };
    "project.column.create": { params: ProjectColumnCreateParams; result: BoardColumn };
    "project.column.update": { params: ProjectColumnUpdateParams; result: BoardColumn };
    "project.column.move": { params: ProjectColumnMoveParams; result: BoardColumn };
    "project.column.delete": { params: ProjectColumnDeleteParams; result: ProjectColumnDeleteResult };
    "project.card.list": { params: ProjectCardListParams; result: ProjectCardListResult };
    "project.card.get": { params: ProjectCardGetParams; result: BoardCard };
    "project.card.create": { params: ProjectCardCreateParams; result: BoardCard };
    "project.card.update": { params: ProjectCardUpdateParams; result: BoardCard };
    "project.card.move": { params: ProjectCardMoveParams; result: BoardCard };
    "project.card.assign": { params: ProjectCardAssignParams; result: BoardCard };
    "project.card.unassign": { params: ProjectCardUnassignParams; result: BoardCard };
    "project.card.archive": { params: ProjectCardArchiveParams; result: BoardCard };
    "project.card.unarchive": { params: ProjectCardUnarchiveParams; result: BoardCard };
    "project.card.comment.add": { params: ProjectCardCommentAddParams; result: BoardComment };
    "project.card.comment.list": { params: ProjectCardCommentListParams; result: ProjectCardCommentListResult };
    "project.card.activity.list": { params: ProjectCardActivityListParams; result: ProjectCardActivityListResult };
  }
}
