import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

export type WSEventType =
  | 'employee:status'      // employee status changed (idle/working)
  | 'employee:task_update'  // task status or result changed
  | 'employee:log'          // new employee log entry
  | 'employee:task_new'     // new task assigned
  | 'manager:log'           // alfred log entry
  | 'manager:status';       // alfred running/stopped

export interface WSEvent {
  type: WSEventType;
  employeeId?: string;
  projectId?: string;
  data: any;
}

class WebSocketService {
  private io: Server | null = null;

  init(server: HttpServer): void {
    this.io = new Server(server, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      path: '/ws',
    });

    this.io.on('connection', (socket: Socket) => {
      console.log(`[WS] Client connected: ${socket.id}`);

      // Join project-specific rooms
      socket.on('join:project', (projectId: string) => {
        socket.join(`project:${projectId}`);
      });

      // Join employee-specific rooms
      socket.on('join:employee', (employeeId: string) => {
        socket.join(`employee:${employeeId}`);
      });

      socket.on('disconnect', () => {
        console.log(`[WS] Client disconnected: ${socket.id}`);
      });
    });
  }

  /** Emit to all connected clients */
  emit(event: WSEvent): void {
    if (!this.io) return;

    // Broadcast to all
    this.io.emit(event.type, event.data);

    // Also emit to specific rooms if applicable
    if (event.employeeId) {
      this.io.to(`employee:${event.employeeId}`).emit(event.type, event.data);
    }
    if (event.projectId) {
      this.io.to(`project:${event.projectId}`).emit(event.type, event.data);
    }
  }

  // Convenience methods

  employeeStatusChanged(employeeId: string, projectId: string, status: string, name: string): void {
    this.emit({
      type: 'employee:status',
      employeeId, projectId,
      data: { employeeId, projectId, status, name, timestamp: new Date() },
    });
  }

  employeeTaskUpdate(employeeId: string, projectId: string, task: { taskId: string; status: string; result?: string; description: string }): void {
    this.emit({
      type: 'employee:task_update',
      employeeId, projectId,
      data: { employeeId, projectId, ...task, timestamp: new Date() },
    });
  }

  employeeTaskNew(employeeId: string, projectId: string, task: { taskId: string; description: string }): void {
    this.emit({
      type: 'employee:task_new',
      employeeId, projectId,
      data: { employeeId, projectId, ...task, timestamp: new Date() },
    });
  }

  employeeLog(employeeId: string, projectId: string, log: { category: string; content: string; employeeName: string }): void {
    this.emit({
      type: 'employee:log',
      employeeId, projectId,
      data: { employeeId, projectId, ...log, timestamp: new Date() },
    });
  }

  managerLog(entry: { type: string; message: string }): void {
    this.emit({ type: 'manager:log', data: { ...entry, timestamp: new Date() } });
  }

  managerStatus(running: boolean): void {
    this.emit({ type: 'manager:status', data: { running, timestamp: new Date() } });
  }
}

export const wsService = new WebSocketService();
