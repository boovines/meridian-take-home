import {
  Bolt,
  Database,
  ListChecks,
  ShieldCheck,
  UserRound,
  CircleCheck,
  Hand,
  type LucideIcon,
} from "lucide-react";
import type { NodeType } from "@/domain/canvas";
export const primitives: Record<
  NodeType,
  { icon: LucideIcon; description: string; prompt: string }
> = {
  trigger: {
    icon: Bolt,
    description: "How this process begins",
    prompt: "What starts this process? What information arrives with it?",
  },
  information: {
    icon: Database,
    description: "Collect the inputs you need",
    prompt: "What information do you need, and where does it come from?",
  },
  task: {
    icon: ListChecks,
    description: "Describe a piece of work",
    prompt:
      "What information do you use? What do you do? What should this produce?",
  },
  check: {
    icon: ShieldCheck,
    description: "Verify or make a decision",
    prompt:
      "What do you check? What counts as passing? What happens if it fails?",
  },
  human_handoff: {
    icon: UserRound,
    description: "Ask a person to take over",
    prompt:
      "Who takes over? What do they need to answer before the process continues?",
  },
  human_approval: {
    icon: Hand,
    description: "Require a person’s decision",
    prompt: "Who approves this, and what do approval and rejection mean?",
  },
  outcome: {
    icon: CircleCheck,
    description: "Define how this process ends",
    prompt: "What is the result? What information should be included?",
  },
};
