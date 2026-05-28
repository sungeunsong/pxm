export abstract class WorkflowRepositoryPort {
  abstract createDefinition(
    id: string,
    name: string,
    nodes: any[],
    edges: any[],
  ): Promise<void>;
  abstract listDefinitions(): Promise<any[]>;
  abstract getDefinition(id: string): Promise<any>;
}

export abstract class WorkflowInstanceRepositoryPort {
  abstract createInstance(
    id: string,
    definitionId: string,
    status: string,
    ctx: any,
  ): Promise<void>;
  abstract listInstances(): Promise<any[]>;
  abstract getInstance(id: string): Promise<any>;
  abstract updateInstanceStatus(id: string, status: string): Promise<void>;
  abstract updateInstanceCtx(id: string, ctx: any): Promise<void>;
  abstract createToken(token: {
    id: string;
    instanceId: string;
    nodeId: string;
    status: string;
    parentTokenId?: string;
    scopeKey?: string;
  }): Promise<void>;
  abstract createJob(job: {
    instanceId: string;
    tokenId?: string | null;
    type: string;
    runAt: Date;
    payload: any;
  }): Promise<void>;
}

export abstract class WorkflowTaskRepositoryPort {
  abstract createTask(
    id: string,
    instanceId: string,
    nodeId: string,
    assignee: string,
    status: string,
    payload: any,
  ): Promise<void>;
  abstract listTasks(assignee?: string): Promise<any[]>;
  abstract getTask(id: string): Promise<any>;
  abstract updateTaskStatus(id: string, status: string): Promise<void>;
}

export abstract class OutboxRepositoryPort {
  abstract fetchAfter(
    instanceId: string,
    afterId: number,
    limit?: number,
  ): Promise<any[]>;

  abstract appendEvent(
    instanceId: string,
    eventType: string,
    payload: any,
  ): Promise<any>;

  abstract fetchTrace(instanceId: string, limit?: number): Promise<any[]>;
}
