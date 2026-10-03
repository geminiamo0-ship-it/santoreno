export class ConversationDO {
  fetch(): Response {
    return Response.json({
      service: "conversation-do",
      status: "ok",
      storage: "sqlite",
    });
  }
}
