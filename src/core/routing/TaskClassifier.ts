/**
 * @file TaskClassifier.ts
 * @description Pure heuristic classifier that determines the {@link TaskCategory}
 * of a conversation based on keyword and pattern matching against the most
 * recent user message. No LLM calls are made — classification is instant.
 */

import { ChatMessage, TaskCategory } from '../providers/types';

/**
 * A single classification rule mapping a regex pattern to a {@link TaskCategory}.
 */
interface ClassificationRule {
  /** The task category this rule detects. */
  readonly category: TaskCategory;
  /** The regex pattern to test against the user's message content. */
  readonly pattern: RegExp;
}

/**
 * Classifies user messages into task categories using keyword and pattern
 * matching heuristics.
 *
 * @remarks
 * The classifier examines only the last user message in the conversation.
 * Rules are evaluated in priority order; the first match wins. If no rule
 * matches, the classifier falls back to `'conversation'` for short messages
 * or `'general'` otherwise.
 *
 * @example
 * ```typescript
 * const classifier = new TaskClassifier();
 * const category = classifier.classify([
 *   { role: 'user', content: 'Write a Python function to sort a list' }
 * ]);
 * // category === 'coding'
 * ```
 */
export class TaskClassifier {
  /** Ordered list of classification rules, evaluated top-to-bottom. */
  private readonly _rules: readonly ClassificationRule[];

  /** Word count threshold below which short messages default to conversation. */
  private readonly _conversationalWordThreshold: number;

  /**
   * Creates a new TaskClassifier with the default rule set.
   */
  public constructor() {
    this._conversationalWordThreshold = 20;

    this._rules = Object.freeze([
      {
        category: 'coding' as TaskCategory,
        pattern:
          /\b(code|function|class|debug|fix|implement|compile|syntax|error|bug|programming|typescript|javascript|python|java|rust|golang|sql|html|css|api|endpoint|database|algorithm|regex|refactor|deploy|git|npm|pip|docker)\b|```/i,
      },
      {
        category: 'translation' as TaskCategory,
        pattern:
          /\b(translate|translation|convert to|in\s+(spanish|french|german|chinese|japanese|korean|portuguese|italian|russian|arabic))\b/i,
      },
      {
        category: 'summarization' as TaskCategory,
        pattern:
          /\b(summarize|summary|tldr|key\s+points|overview|brief|condense|recap|digest|outline)\b/i,
      },
      {
        category: 'analysis' as TaskCategory,
        pattern:
          /\b(analyze|analysis|compare|evaluate|assess|examine|investigate|report|data|statistics|metrics|trend|insight|benchmark)\b/i,
      },
      {
        category: 'creative' as TaskCategory,
        pattern:
          /\b(write|story|poem|creative|fiction|narrative|blog|essay|script|dialogue|character|imagine|invent)\b/i,
      },
    ]);
  }

  /**
   * Classifies a conversation into a {@link TaskCategory} based on the
   * content of the last user message.
   *
   * @param messages - The conversation history to classify. At least one
   *   message with `role === 'user'` should be present.
   * @returns The detected task category. Returns `'conversation'` for short
   *   or conversational messages, `'general'` if no specific pattern matches.
   */
  public classify(messages: ChatMessage[]): TaskCategory {
    const lastUserMessage = this._getLastUserMessage(messages);

    if (!lastUserMessage) {
      return 'general';
    }

    const content = lastUserMessage.trim();

    if (content.length === 0) {
      return 'general';
    }

    // Check each rule in priority order — first match wins
    for (const rule of this._rules) {
      if (rule.pattern.test(content)) {
        return rule.category;
      }
    }

    // Short messages that didn't match any pattern are likely conversational
    const wordCount = content.split(/\s+/).length;
    if (wordCount < this._conversationalWordThreshold) {
      return 'conversation';
    }

    return 'general';
  }

  /**
   * Extracts the content of the last user message from the conversation.
   *
   * @param messages - The full conversation history.
   * @returns The content string of the last user message, or `null` if none exists.
   */
  private _getLastUserMessage(messages: ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return messages[i].content;
      }
    }
    return null;
  }
}
