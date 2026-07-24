'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The single input for everything the user says to Coach — typed or spoken.
 *
 * Voice uses the browser's Web Speech API where available (Safari on iOS
 * supports it), and degrades silently to text-only where it isn't. Text always
 * works: voice is a convenience, never a requirement (§26).
 */
export function CoachBar({
  onSubmit,
  placeholder = 'Say "Coach"…',
  autoFocus = false,
}: {
  onSubmit: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    setVoiceSupported(true);
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((r: any) => r[0].transcript)
        .join('');
      setValue(transcript);
      // Submit only on a final result — a draft room is noisy and partial
      // transcripts would fire commands the user never finished saying.
      if (event.results[event.results.length - 1].isFinal) {
        const text = transcript.trim();
        if (text) {
          onSubmit(text);
          setValue('');
        }
      }
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognitionRef.current = recognition;
    return () => {
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [onSubmit]);

  const toggleListening = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (listening) {
      recognition.stop();
      setListening(false);
    } else {
      try {
        recognition.start();
        setListening(true);
      } catch {
        setListening(false);
      }
    }
  };

  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.trim();
        if (!text) return;
        onSubmit(text);
        setValue('');
      }}
    >
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={listening ? 'Listening…' : placeholder}
        autoFocus={autoFocus}
        // Autocorrect turns player surnames into nonsense; off on all counts.
        autoCorrect="off"
        autoCapitalize="words"
        spellCheck={false}
        enterKeyHint="send"
        aria-label="Ask Coach"
        className="min-h-[48px] flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 text-[16px] outline-none focus:border-[var(--accent)]"
      />
      {voiceSupported && (
        <button
          type="button"
          onClick={toggleListening}
          aria-label={listening ? 'Stop listening' : 'Speak to Coach'}
          aria-pressed={listening}
          className={`btn min-w-[52px] ${
            listening ? 'bg-[var(--danger)] text-white' : 'btn-ghost'
          }`}
        >
          {listening ? '■' : '🎙'}
        </button>
      )}
      <button type="submit" className="btn-primary min-w-[52px]" aria-label="Send">
        ↑
      </button>
    </form>
  );
}
