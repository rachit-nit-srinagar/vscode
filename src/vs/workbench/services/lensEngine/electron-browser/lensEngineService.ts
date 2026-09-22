import { ILensEngineService } from '../../../../platform/lensEngine/common/lensEngine.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';

registerMainProcessRemoteService(ILensEngineService, 'lensEngine');
