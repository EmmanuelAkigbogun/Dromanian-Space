# Agent sources

Darkspace runs one coordinator and 19 specialists. The runtime is Agno on
Cerebras `gpt-oss-120b`; the specialist designs below are adapted from public
GitHub projects to Darkspace's existing, tenant-aware tools. The application
does not send workspace data to those repositories or deploy their databases.

| Darkspace agent | GitHub pattern used |
| --- | --- |
| Team Coordinator | [Agno teams and human approval](https://github.com/agno-agi/agno) |
| Research Specialist | [Agno research and knowledge examples](https://github.com/agno-agi/agno) |
| Data Analyst | [Agno structured-output examples](https://github.com/agno-agi/agno) |
| Content & Notes Specialist | [Agno content workflows](https://github.com/agno-agi/agno) |
| Scout | [Agno Scout](https://github.com/agno-agi/scout) |
| Drive Agent | [Agno Drive tools and human approval](https://github.com/agno-agi/agno) |
| Social Media Calendar | [Pendpost](https://github.com/pendpost/pendpost) and [Agno content planning](https://github.com/agno-agi/agno) |
| Customer Support | [LangWatch bank example](https://github.com/langwatch/bank-example) and [Agno support pattern](https://github.com/agno-agi/agno) |
| SEO Specialist | [SEO InsightHub](https://github.com/SimranShaikh20/SEO-InsightHub-Powered-by-Agno-AI-Agent-Framework) |
| Sales Development | [Agno Scout](https://github.com/agno-agi/scout) |
| Recruiting Assistant | [Enterprise AI Agents](https://github.com/bhanuchaddha/enterprise-ai-agents) |
| Marketing Strategist | [BlackTwist social-media skills](https://github.com/blacktwist/social-media-skills) and [Agno workflows](https://github.com/agno-agi/agno) |
| Creative Director | [BlackTwist social-media skills](https://github.com/blacktwist/social-media-skills) |
| Email Marketing | [BlackTwist social-media skills](https://github.com/blacktwist/social-media-skills) and [Agno content workflows](https://github.com/agno-agi/agno) |
| Commerce Analyst | [Agno structured-output examples](https://github.com/agno-agi/agno) |
| Executive Assistant | [Agno meeting-prep example](https://github.com/agno-agi/agno) and [Agno Context](https://github.com/agno-agi/context) |
| Project Manager | [Agno workflows and human approval](https://github.com/agno-agi/agno) |
| Finance Analyst | [Agno finance agent](https://github.com/agno-agi/agent-api) and [Agno structured output](https://github.com/agno-agi/agno) |
| Competitor Intelligence | [Enterprise AI Agents](https://github.com/bhanuchaddha/enterprise-ai-agents) and [Agno Scout](https://github.com/agno-agi/scout) |
| Customer Success | [LangWatch bank example](https://github.com/langwatch/bank-example) |

Every read runs as the requesting user. Any task, document, message, calendar,
Drive or CRM mutation goes through Darkspace's existing review flow. The Social
Media Calendar agent produces a dated calendar document; it has no publishing
tool and cannot silently schedule posts.
