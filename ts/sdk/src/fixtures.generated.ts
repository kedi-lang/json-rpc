// Generated from fixtures/v1 by scripts/generate-fixtures.ts; do not edit.

export const FIXTURES = [
  {
    "name": "cancel",
    "code": "KB109",
    "description": "run/cancel stops the run: it answers -32003.",
    "failure": "run/cancel does not stop the run",
    "help": "pass run.signal to every wait; a cancelled run answers -32003",
    "spec": "5-runs",
    "onModelRequest": {
      "1": [
        {
          "send": "run/cancel"
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Too late."
          }
        ]
      }
    ],
    "expect": {
      "error": {
        "code": -32003
      }
    }
  },
  {
    "name": "codemode-native",
    "code": "KB119",
    "description": "With native code mode, Kedi's tools reach the model only through the backend's code tool.",
    "failure": "native code mode still offers Kedi's tools to the model as tools of their own",
    "help": "with run.params.codemode mode native, turn the backend's code mode on and offer Kedi's tools to its code only",
    "spec": "5-runs",
    "capabilities": [
      "codemode",
      "tools"
    ],
    "run": {
      "tools": [
        {
          "name": "lookup",
          "description": "Look up a city's country.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          },
          "outputSchema": null,
          "requiredBeforeOutput": false
        }
      ],
      "codemode": {
        "mode": "native"
      }
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Ready."
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "text": "Ready."
      },
      "modelTools": [
        {
          "request": 1,
          "atLeast": 1,
          "excludes": [
            "lookup"
          ]
        }
      ]
    }
  },
  {
    "name": "compaction",
    "code": "KB118",
    "description": "With a native compaction policy, a session past its threshold is compacted: the summary request reaches the test model with purpose compaction, is admitted like any request, reports no event, and the run still answers with its state.",
    "failure": "the bridge does not compact its session at the program's threshold",
    "help": "with run.params.compaction mode native, compact the session once it passes threshold input tokens, sending the summary request through run.modelRequest with purpose compaction",
    "spec": "7-history",
    "capabilities": [
      "sessions",
      "compactionThreshold"
    ],
    "run": {
      "user": "Where is Lyon?",
      "tools": [
        {
          "name": "lookup",
          "description": "Look up a city's country.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          },
          "outputSchema": null,
          "requiredBeforeOutput": false
        }
      ],
      "session": {
        "id": "s1",
        "turn": 0,
        "state": null
      },
      "compaction": {
        "mode": "native",
        "threshold": 1
      }
    },
    "model": [
      {
        "parts": [
          {
            "type": "toolCall",
            "id": "t1",
            "name": "lookup",
            "arguments": {
              "city": "Lyon"
            }
          }
        ],
        "usage": {
          "inputTokens": 5000,
          "outputTokens": 10
        }
      },
      {
        "parts": [
          {
            "type": "text",
            "text": "Lyon is in France."
          }
        ],
        "usage": {
          "inputTokens": 6000,
          "outputTokens": 10
        }
      }
    ],
    "summaries": [
      {
        "parts": [
          {
            "type": "text",
            "text": "The user asked where Lyon is."
          }
        ],
        "usage": {
          "inputTokens": 5000,
          "outputTokens": 20
        }
      }
    ],
    "tools": {
      "lookup": {
        "result": "France"
      }
    },
    "expect": {
      "result": {
        "text": "Lyon is in France."
      },
      "resultKeys": [
        "state"
      ],
      "compacted": true
    }
  },
  {
    "name": "continuation",
    "code": "KB112",
    "description": "A continuation replays the rejected answer and Kedi's correction to the model.",
    "failure": "a continuation does not replay the rejected answer and Kedi's correction",
    "help": "replay run.params.continuation: its answer as the model's turn, its message as a user turn",
    "spec": "5-runs",
    "run": {
      "continuation": {
        "answer": {
          "text": "Paris."
        },
        "message": "That was not asked. Answer again."
      }
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Hello."
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "text": "Hello."
      },
      "modelSaw": [
        {
          "request": 1,
          "contains": "Paris."
        },
        {
          "request": 1,
          "contains": "That was not asked. Answer again."
        }
      ]
    }
  },
  {
    "name": "events",
    "code": "KB113",
    "description": "With events, the model's text beside its tool calls is reported as commentary.",
    "failure": "the bridge's events do not report the model's commentary",
    "help": "send run/event message.completed with phase commentary for text beside tool calls (run.event)",
    "spec": "4-capabilities",
    "capabilities": [
      "events",
      "tools"
    ],
    "run": {
      "tools": [
        {
          "name": "lookup",
          "description": "Look up a city's country.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          },
          "outputSchema": null,
          "requiredBeforeOutput": false
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Let me look it up."
          },
          {
            "type": "toolCall",
            "id": "t1",
            "name": "lookup",
            "arguments": {
              "city": "Lyon"
            }
          }
        ]
      },
      {
        "parts": [
          {
            "type": "text",
            "text": "Lyon is in France."
          }
        ]
      }
    ],
    "tools": {
      "lookup": {
        "result": "France"
      }
    },
    "expect": {
      "result": {
        "text": "Lyon is in France."
      },
      "events": [
        {
          "type": "message.completed",
          "phase": "commentary",
          "text": "Let me look it up."
        }
      ]
    }
  },
  {
    "name": "governed-admits-each-request",
    "code": "KB103",
    "description": "A governed bridge asks budget/admit before every model request.",
    "failure": "model requests are not all admitted",
    "help": "send every model request through run.modelRequest, and turn off the harness's own retries",
    "spec": "4-capabilities",
    "capabilities": [
      "governed",
      "tools"
    ],
    "run": {
      "tools": [
        {
          "name": "lookup",
          "description": "Look up a city's country.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          },
          "outputSchema": null,
          "requiredBeforeOutput": false
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "toolCall",
            "id": "t1",
            "name": "lookup",
            "arguments": {
              "city": "Lyon"
            }
          }
        ]
      },
      {
        "parts": [
          {
            "type": "text",
            "text": "Done."
          }
        ]
      }
    ],
    "tools": {
      "lookup": {
        "result": "France"
      }
    },
    "expect": {
      "result": {
        "text": "Done."
      },
      "order": [
        "budget/admit",
        "model/complete",
        "tool/call",
        "budget/admit",
        "model/complete"
      ],
      "count": [
        {
          "method": "budget/admit",
          "times": 2
        }
      ]
    }
  },
  {
    "name": "governed-denied-request",
    "code": "KB104",
    "description": "A denied request never reaches the model, and the run fails.",
    "failure": "a denied request does not end the run",
    "help": "when budget/admit denies a request, skip it and end the run (run.modelRequest throws StepDenied)",
    "spec": "6-steps-kedi-decides",
    "capabilities": [
      "governed",
      "tools"
    ],
    "budget": {
      "request": 1
    },
    "run": {
      "tools": [
        {
          "name": "lookup",
          "description": "Look up a city's country.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          },
          "outputSchema": null,
          "requiredBeforeOutput": false
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "toolCall",
            "id": "t1",
            "name": "lookup",
            "arguments": {
              "city": "Lyon"
            }
          }
        ]
      },
      {
        "parts": [
          {
            "type": "text",
            "text": "Never sent."
          }
        ]
      }
    ],
    "tools": {
      "lookup": {
        "result": "France"
      }
    },
    "expect": {
      "failed": true,
      "modelRequests": 1
    }
  },
  {
    "name": "history-processing",
    "code": "KB116",
    "description": "With processHistory, the request carries what the program's history processor kept, and the run answers the whole transcript.",
    "failure": "the history processor's result does not decide what the request carries",
    "help": "ask history/process before each request, send what it returns, and answer transcript",
    "spec": "7-history",
    "capabilities": [
      "transcript"
    ],
    "historyProcess": {
      "keepLast": 1
    },
    "run": {
      "user": "What is my name?",
      "history": [
        {
          "id": "m1",
          "role": "user",
          "parts": [
            {
              "type": "text",
              "text": "My name is Ada."
            }
          ]
        },
        {
          "id": "m2",
          "role": "assistant",
          "parts": [
            {
              "type": "text",
              "text": "Hello, Ada."
            }
          ]
        }
      ],
      "processHistory": true
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "I do not know."
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "text": "I do not know."
      },
      "resultKeys": [
        "transcript"
      ],
      "modelMissed": [
        {
          "request": 1,
          "contains": "My name is Ada."
        }
      ],
      "count": [
        {
          "method": "history/process",
          "times": 1
        }
      ]
    }
  },
  {
    "name": "interrupt-session",
    "code": "KB108",
    "description": "An interrupted run in a session answers -32006 with its state, so the conversation continues.",
    "failure": "an interrupted session run does not hand back its state",
    "help": "register run.onInterrupt to return {state} as the run has it so far",
    "spec": "8-children-and-live-input",
    "capabilities": [
      "interrupt",
      "sessions"
    ],
    "run": {
      "session": {
        "id": "s1",
        "turn": 0,
        "state": null
      }
    },
    "onModelRequest": {
      "1": [
        {
          "send": "run/interrupt"
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Too late."
          }
        ]
      }
    ],
    "expect": {
      "error": {
        "code": -32006
      },
      "errorDataKeys": [
        "state"
      ]
    }
  },
  {
    "name": "interrupt-transcript",
    "code": "KB117",
    "description": "An interrupted transcript run answers -32006 with the turn's messages so far.",
    "failure": "an interrupted transcript run does not hand back its messages",
    "help": "register run.onInterrupt to return {messages}, the turn so far in Kedi's schema",
    "spec": "8-children-and-live-input",
    "capabilities": [
      "interrupt",
      "transcript"
    ],
    "run": {
      "history": [
        {
          "id": "m1",
          "role": "user",
          "parts": [
            {
              "type": "text",
              "text": "My name is Ada."
            }
          ]
        },
        {
          "id": "m2",
          "role": "assistant",
          "parts": [
            {
              "type": "text",
              "text": "Hello, Ada."
            }
          ]
        }
      ]
    },
    "onModelRequest": {
      "1": [
        {
          "send": "run/interrupt"
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Too late."
          }
        ]
      }
    ],
    "expect": {
      "error": {
        "code": -32006
      },
      "errorDataKeys": [
        "messages"
      ]
    }
  },
  {
    "name": "interrupt",
    "code": "KB107",
    "description": "run/interrupt stops the attempt: the run answers -32006.",
    "failure": "run/interrupt does not stop the attempt",
    "help": "pass run.signal to every wait; an interrupted run answers -32006",
    "spec": "8-children-and-live-input",
    "capabilities": [
      "interrupt"
    ],
    "onModelRequest": {
      "1": [
        {
          "send": "run/interrupt"
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Too late."
          }
        ]
      }
    ],
    "expect": {
      "error": {
        "code": -32006
      }
    }
  },
  {
    "name": "kedi-tool",
    "code": "KB101",
    "description": "The model calls a Kedi tool; its result reaches the next model request.",
    "failure": "Kedi's tools do not round-trip",
    "help": "call Kedi's tools with tool/call (run.callTool) and send their results to the model",
    "spec": "6-steps-kedi-decides",
    "capabilities": [
      "tools"
    ],
    "run": {
      "tools": [
        {
          "name": "lookup",
          "description": "Look up a city's country.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          },
          "outputSchema": null,
          "requiredBeforeOutput": false
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "toolCall",
            "id": "t1",
            "name": "lookup",
            "arguments": {
              "city": "Lyon"
            }
          }
        ]
      },
      {
        "parts": [
          {
            "type": "text",
            "text": "Lyon is in France."
          }
        ]
      }
    ],
    "tools": {
      "lookup": {
        "result": "France"
      }
    },
    "expect": {
      "result": {
        "text": "Lyon is in France."
      },
      "modelRequests": 2,
      "modelSaw": [
        {
          "request": 2,
          "contains": "France"
        }
      ],
      "order": [
        "model/complete",
        "tool/call",
        "model/complete"
      ]
    }
  },
  {
    "name": "line-separators",
    "code": "KB111",
    "description": "U+2028, U+2029 and CR stay inside one frame.",
    "failure": "U+2028, U+2029 or CR change the prompt",
    "help": "split frames at LF only and pass the text through as given",
    "spec": "2-transport",
    "run": {
      "user": "one two three\rfour"
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Read."
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "text": "Read."
      },
      "modelSaw": [
        {
          "request": 1,
          "contains": "one two three\rfour"
        }
      ]
    }
  },
  {
    "name": "live-input",
    "code": "KB106",
    "description": "Input sent while the run runs reaches the next model request, and is acknowledged delivered.",
    "failure": "live input does not reach the next model request",
    "help": "register run.onInput and add each text as a user turn; run.modelRequest answers it delivered",
    "spec": "8-children-and-live-input",
    "capabilities": [
      "liveInput",
      "tools"
    ],
    "run": {
      "tools": [
        {
          "name": "lookup",
          "description": "Look up a city's country.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "city": {
                "type": "string"
              }
            },
            "required": [
              "city"
            ]
          },
          "outputSchema": null,
          "requiredBeforeOutput": false
        }
      ]
    },
    "onModelRequest": {
      "1": [
        {
          "send": "run/input",
          "items": [
            {
              "id": "i1",
              "text": "Use the blue one."
            }
          ]
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "toolCall",
            "id": "t1",
            "name": "lookup",
            "arguments": {
              "city": "Lyon"
            }
          }
        ]
      },
      {
        "parts": [
          {
            "type": "text",
            "text": "Blue it is."
          }
        ]
      }
    ],
    "tools": {
      "lookup": {
        "result": "France"
      }
    },
    "expect": {
      "result": {
        "text": "Blue it is."
      },
      "modelSaw": [
        {
          "request": 2,
          "contains": "Use the blue one."
        }
      ],
      "answers": [
        {
          "method": "run/input",
          "result": {
            "delivered": true
          }
        }
      ]
    }
  },
  {
    "name": "media-input",
    "code": "KB114",
    "description": "An image of the user turn reaches the model.",
    "failure": "the user turn's media does not reach the model",
    "help": "send run.params.userContent's media parts to the model where Kedi put them",
    "spec": "5-runs",
    "capabilities": [
      "mediaInput"
    ],
    "run": {
      "user": "Look at photo please.",
      "userContent": [
        {
          "type": "text",
          "text": "Look at "
        },
        {
          "type": "media",
          "name": "photo",
          "kind": "image",
          "mediaType": "image/png",
          "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
        },
        {
          "type": "text",
          "text": " please."
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "A pixel."
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "text": "A pixel."
      },
      "modelSaw": [
        {
          "request": 1,
          "contains": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
        }
      ]
    }
  },
  {
    "name": "model-fallback",
    "code": "KB115",
    "description": "When the primary model fails, the request is tried on the fallback model.",
    "failure": "a failed request is not tried on the fallback models",
    "help": "with modelFallback, try run.params.fallbackModels in order when a request fails (run.modelRequest does)",
    "spec": "4-capabilities",
    "capabilities": [
      "modelFallback"
    ],
    "failModels": [
      "primary"
    ],
    "run": {
      "model": "primary",
      "fallbackModels": [
        "backup"
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "From the backup."
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "text": "From the backup."
      },
      "modelRequests": 2,
      "modelSaw": [
        {
          "request": 2,
          "contains": "backup"
        }
      ]
    }
  },
  {
    "name": "structured",
    "code": "KB102",
    "description": "A structured run answers with data.",
    "failure": "a structured run does not answer with data",
    "help": "parse the model's answer against run.output.schema and answer {data}",
    "spec": "5-runs",
    "capabilities": [
      "structuredOutput"
    ],
    "run": {
      "callKind": "produce",
      "output": {
        "schema": {
          "type": "object",
          "properties": {
            "capital": {
              "type": "string"
            }
          },
          "required": [
            "capital"
          ]
        },
        "toolName": "final_result"
      }
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "{\"capital\": \"Ankara\"}"
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "data": {
          "capital": "Ankara"
        }
      },
      "modelRequests": 1
    }
  },
  {
    "name": "text",
    "code": "KB100",
    "description": "Kedi's prompt reaches the model and its text is the run's answer.",
    "failure": "a text run does not answer with the model's text",
    "help": "answer {text} with the model's reply",
    "spec": "5-runs",
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Hello there."
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "text": "Hello there."
      },
      "modelRequests": 1,
      "modelSaw": [
        {
          "request": 1,
          "contains": "Hello."
        }
      ]
    }
  },
  {
    "name": "transcript",
    "code": "KB105",
    "description": "Kedi's transcript reaches the model; the turn's messages come back.",
    "failure": "Kedi's transcript does not reach the model, or the turn's messages do not come back",
    "help": "build the conversation from run.params.history and answer the turn's messages",
    "spec": "7-history",
    "capabilities": [
      "transcript"
    ],
    "run": {
      "user": "What is my name?",
      "history": [
        {
          "id": "m1",
          "role": "user",
          "parts": [
            {
              "type": "text",
              "text": "My name is Ada."
            }
          ]
        },
        {
          "id": "m2",
          "role": "assistant",
          "parts": [
            {
              "type": "text",
              "text": "Hello, Ada."
            }
          ]
        }
      ]
    },
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Ada."
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "text": "Ada."
      },
      "resultKeys": [
        "messages"
      ],
      "modelSaw": [
        {
          "request": 1,
          "contains": "My name is Ada."
        }
      ]
    }
  },
  {
    "name": "usage",
    "code": "KB110",
    "description": "With usage, one run/usage per model request.",
    "failure": "a model request's usage is not reported",
    "help": "return the reply's token counts from the request's usage()",
    "spec": "9-usage",
    "capabilities": [
      "usage"
    ],
    "model": [
      {
        "parts": [
          {
            "type": "text",
            "text": "Counted."
          }
        ]
      }
    ],
    "expect": {
      "result": {
        "text": "Counted."
      },
      "count": [
        {
          "method": "run/usage",
          "times": 1
        }
      ]
    }
  }
] as const;
