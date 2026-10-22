# Changelog

What changed in each version of p3n for Obsidian. Downloads are on the [releases page](https://github.com/Barabosik/p3n-obsidian/releases).

## 0.1.4

- **Rewrite** needs a sentence of eight words or more, and now says so before it sends anything, as **Check for AI** already did for text under 40 characters.
- Text over 5,000 characters without an API key: the message now has an **Add an API key** button.
- A key you pick in **Settings → p3n** or the API key window is saved only once p3n accepts it, so a mistyped key never replaces one that works. The line under it says who it signs in as.
- **p3n: Check for AI** and **p3n: Rewrite** now also work while the p3n view has the focus, from the command palette or your own hotkeys, on the note you were last in.
- The first check or rewrite opens the results without taking the focus out of your note, as later ones already did.
- A note in reading view: the commands aren't offered there, and the view's buttons ask you to switch to editing view, instead of sending a selection you can't see.
- After a rewrite, p3n says so if it left out links (`[[wikilinks]]` or Markdown links) that were in your selection, before you replace it.
- **Copy** says so when the clipboard refuses, instead of doing nothing.
- The results work in a pop-out window: the score counts up there, and the keyboard focus comes back after **Try another rewrite**.
- The plugin's description now reads: "Select text, see if it reads as AI-written, or rewrite it in place, with the p3n API."

## 0.1.3

- New command **p3n: Set API key** opens the API key window from the command palette.
- The free-limit message says "free calls", not "free checks" (rewrites count too), and says to sign up at p3n.si before creating an API key.
- The note under a rewrite says "The rewrite" instead of "Humanize".

## 0.1.2

- Screen-reader text is hidden without CSS `clip-path`, which was the only warning on the Community directory's scorecard.

## 0.1.1

- The plugin id is now `ai-pen`, because Obsidian's Community directory takes only lowercase letters and hyphens in ids. The name is still p3n.
- If you installed 0.1.0 by hand into `.obsidian/plugins/p3n/`, remove that folder and install into `.obsidian/plugins/ai-pen/`.

## 0.1.0

First release. Select text in a note and see if it reads as AI-written, or rewrite it in place.

- **p3n: Check for AI**: a score, a one-line reason, and the sentences that give it away.
- **p3n: Rewrite**, with **Replace selection** as one undo step, and **Copy**.
- Results open in a side view, on desktop and mobile.
- Free without an account: 10 calls an hour, up to 5,000 characters each.
