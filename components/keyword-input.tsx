"use client";

/**
 * Keyword Input
 *
 * Tag-style input for adding/removing keywords.
 */

import { useI18n } from "@/lib/i18n/provider";
import { useState, type KeyboardEvent } from "react";

interface KeywordInputProps {
  keywords: string[];
  onChange: (keywords: string[]) => void;
  max?: number;
}

export default function KeywordInput({ keywords, onChange, max = 10 }: KeywordInputProps) {
  const { t } = useI18n();
  const [input, setInput] = useState("");

  function addKeyword(value: string) {
    // Split on spaces/commas so "لینک link" becomes two triggers, not one
    // impossible phrase that never matches a single-word comment.
    const parts = value
      .split(/[\s,]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) return;

    let next = [...keywords];
    for (const part of parts) {
      const normalized = part.toUpperCase();
      if (!normalized || next.includes(normalized)) continue;
      if (next.length >= max) break;
      next.push(normalized);
    }
    if (next.length === keywords.length) return;
    onChange(next);
    setInput("");
  }

  function removeKeyword(keyword: string) {
    onChange(keywords.filter((k) => k !== keyword));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(input);
    }
    if (e.key === "Backspace" && !input && keywords.length > 0) {
      removeKeyword(keywords[keywords.length - 1]);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 p-3 rounded bg-surface border border-border min-h-[48px]">
        {keywords.map((keyword) => (
          <span
            key={keyword}
            className="inline-flex items-center gap-2 px-2 py-1 rounded border border-border text-xs"
          >
            {keyword}
            <button
              type="button"
              onClick={() => removeKeyword(keyword)}
              aria-label={t("Remove {keyword}", { keyword })}
              className="text-muted hover:text-error"
            >
              {t("Remove")}
            </button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={keywords.length === 0 ? t("Type keyword and press Enter...") : ""}
          className="flex-1 min-w-[120px] bg-transparent text-sm text-foreground placeholder:text-zinc-500 outline-none"
        />
      </div>
      <p className="text-xs text-muted">
        {keywords.length}/{max} {t("keywords · Press Enter or comma to add")}
      </p>
    </div>
  );
}
