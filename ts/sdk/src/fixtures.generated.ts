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
