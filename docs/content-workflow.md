# Content Workflow

The writing flow separates drafting, evidence, distribution, and operating experience.

```text
Obsidian draft
  -> repo markdown
  -> Velog summary/link
  -> site publish
```

## Obsidian draft

Use Obsidian for early thinking:

- rough notes
- diagrams
- commands tried
- questions and follow-ups
- private context that may not belong in the public post

Drafts can be messy. They are not the permanent source of truth.

## repo markdown

Move publishable material into repository Markdown when the post needs to become reproducible.

The repo version should include:

- final explanation
- relevant commands
- configuration snippets
- links to related commits or manifests
- screenshots or evidence, when useful
- exact assumptions and constraints

This makes the post reviewable, diffable, and tied to the same history as the site.

## Velog summary/link

Publish a shorter Velog post when the topic is useful for public reading.

Velog should contain:

- the problem
- the main idea
- the result
- a link to the self-hosted post or repository evidence

Velog is the explanation and discovery surface. It does not need every operational detail.

## site publish

Publish the self-hosted site from the repository.

The site should show the running version of the operating record:

- post content served from the repo
- deployment tied to a commit
- uptime and synthetic checks, once added
- rollback history, once added
- operational notes that prove the service is maintained

## responsibility split

Use this rule:

- blog = explanation
- repo = reproducible evidence
- running site = operating experience

The same topic can appear in all three places, but each place should carry a different responsibility.
