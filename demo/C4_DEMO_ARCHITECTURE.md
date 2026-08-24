# Token-Goat Approval Demo — C4 Architecture Specification

This document details the architectural structure and data flow of the **Token-Goat Approval Demo** (`demo/`) subsystem using the C4 model.

---

## 1. System Context Diagram (Level 1)

```mermaid
flowchart TB
    classDef person fill:#08427B,stroke:#073B6F,color:#ffffff,font-weight:bold;
    classDef demoApp fill:#1168BD,stroke:#0B4884,color:#ffffff,font-weight:bold;
    classDef engine fill:#2563EB,stroke:#1D4ED8,color:#ffffff;
    classDef external fill:#475569,stroke:#334155,color:#ffffff;

    Reviewer["👤 Architecture Reviewer / Executive<br/><small>[Person] Evaluates token efficiency, security posture, and ROI</small>"]:::person

    subgraph DemoSubsystem ["Token-Goat Interactive Demo (Local Browser)"]
        DemoUI["🖥️ Approval Demo Web Application<br/><small>[Vanilla JS, CSS3, HTML5]</small><br/>Interactive scenario runner, live evidence viewer, ROI calculator"]:::demoApp
    end

    subgraph CoreEngine ["Token-Goat Core Runtime"]
        TGCLI["⚡ Token-Goat Engine<br/><small>[dist/token-goat.mjs]</small><br/>100+ surgical extraction commands, image shrinker, hook relays"]:::engine
        Fixtures["📁 Benchmark Fixtures & PDFs<br/><small>[demo/fixtures/]</small><br/>Enterprise briefs, single-slide PPTX, Oracle SQL schemas"]:::external
    end

    Reviewer -->|Views evidence & toggles scenarios| DemoUI
    DemoUI -.->|Renders captured outputs from| TGCLI
    TGCLI -->|Processes realistic samples from| Fixtures
```

---

## 2. Container Diagram (Level 2)

```mermaid
flowchart TB
    classDef client fill:#1E40AF,stroke:#172554,color:#ffffff,font-weight:bold;
    classDef script fill:#0D9488,stroke:#115E59,color:#ffffff,font-weight:bold;
    classDef data fill:#0284C7,stroke:#0369A1,color:#ffffff;

    subgraph WebContainer ["Single-Page Presentation Container (Browser Context)"]
        HTML["index.html<br/><small>Semantic structure, dark-theme layout, metric cards</small>"]:::client
        AppJS["demo.js<br/><small>Tab state, interactive diff viewer, ROI calculator, modal manager</small>"]:::client
        Styles["demo.css<br/><small>CSS variables, responsive flex/grid, zero external font deps</small>"]:::client
        FeatureData["features.js<br/><small>Structured catalog of 11 core token-reduction capabilities</small>"]:::data
        EvidenceData["evidence.js<br/><small>Pre-computed token telemetry, raw vs compressed payloads</small>"]:::data
    end

    subgraph GeneratorContainer ["Evidence Pipeline Container (Node.js Build Time)"]
        GenFeatures["generate-demo-features.mjs<br/><small>Compiles feature definitions into features.js</small>"]:::script
        GenEvidence["generate-demo-evidence.mjs<br/><small>Executes real token-goat commands on demo/fixtures/<br/>and serializes exact evidence into evidence.js</small>"]:::script
    end

    HTML --> AppJS
    HTML --> Styles
    AppJS --> FeatureData
    AppJS --> EvidenceData

    GenFeatures -.->|Emits code| FeatureData
    GenEvidence -.->|Emits code| EvidenceData
```

---

## 3. Component Diagram (Level 3)

```mermaid
flowchart TB
    classDef core fill:#1D4ED8,stroke:#1E3A8A,color:#ffffff,font-weight:bold;
    classDef comp fill:#2563EB,stroke:#1D4ED8,color:#ffffff;
    classDef store fill:#0D9488,stroke:#115E59,color:#ffffff;

    subgraph DemoComponents ["demo.js Component Architecture"]
        Router["Navigation Controller<br/><small>Handles tab switching & URL hash routing</small>"]:::core
        EvidenceViewer["Evidence Comparator<br/><small>Renders side-by-side terminal output and byte savings</small>"]:::comp
        RoiEngine["ROI Modeling Engine<br/><small>Computes dynamic cost savings based on team size & LLM rates</small>"]:::comp
        ScenarioPlayer["Interactive Scenario Runner<br/><small>Step-by-step walkthrough of Claude Code / Copilot flows</small>"]:::comp
        StateStore["Local State Manager<br/><small>Preserves active tab, custom ROI params in localStorage</small>"]:::store
    end

    Router --> EvidenceViewer
    Router --> RoiEngine
    Router --> ScenarioPlayer
    RoiEngine <--> StateStore
    Router <--> StateStore
```

---

## 4. Sequence Diagram (Level 4 Dynamic Flow)

```mermaid
sequenceDiagram
    autonumber
    actor Reviewer as Architecture Reviewer
    participant Browser as demo/index.html
    participant App as demo/demo.js
    participant Evidence as demo/evidence.js
    participant Features as demo/features.js

    Reviewer->>Browser: Opens demo in browser
    Browser->>App: Initializes DOMContentLoaded
    App->>Features: Loads feature taxonomy
    App->>Evidence: Loads verified test evidence runs
    App->>Browser: Renders 11 feature tiles & summary metrics (-78% Token Reduction)
    
    Reviewer->>Browser: Clicks "Surgical Symbol Read" scenario
    Browser->>App: Invokes selectFeature('surgical-read')
    App->>Evidence: Retrieves payload for evidence/03-surgical-read.txt
    App->>Browser: Displays side-by-side comparison: 2,800 lines vs 54 lines (98% reduction)
    
    Reviewer->>Browser: Adjusts team size to 25 engineers in ROI calculator
    Browser->>App: Dispatches calculateRoi(teamSize=25, model="Claude 3.5 Sonnet")
    App->>Browser: Updates annual projected savings display ($142,500/year)
```
