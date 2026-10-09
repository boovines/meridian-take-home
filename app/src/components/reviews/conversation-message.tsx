"use client";
import type { ReactNode } from "react";
import type { DiscussionMessage } from "@/domain/review";
import { Bot, UserRound, Check } from "lucide-react";
export interface MessageProps {
  message: DiscussionMessage;
  children?: ReactNode;
}
export function ConversationMessage({ message, children }: MessageProps) {
  const owner = message.author_kind === "customer";
  const engineer = message.author_kind === "engineer";
  const activity =
    message.author_kind === "system" ||
    message.event_data?.action === "reply_proposal_decided";
  const Icon = activity ? Check : owner || engineer ? UserRound : Bot;
  return (
    <article
      className={`conversation-message ${owner ? "owner" : "assistant"}${activity ? " activity" : ""}`}
    >
      <span className="conversation-avatar">
        <Icon size={14} />
      </span>
      <div className="conversation-message-body">
        <div className="conversation-byline">
          <strong>
            {activity
              ? "Activity"
              : owner
                ? "You · Process expert"
                : engineer
                  ? "Engineer"
                  : "AI reviewer"}
          </strong>
          <time dateTime={message.created_at}>
            {new Date(message.created_at).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </div>
        <div className="conversation-bubble">
          <p>{message.body}</p>
          {children}
        </div>
      </div>
    </article>
  );
}
