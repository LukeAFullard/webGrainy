export type * from './types/index.js';

export {
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  DEFAULT_HF_BASE_URL,
  MODEL_FILES,
  MODEL_REVISION,
  MODEL_INTEGRITY,
  sha256Hex,
  type ModelIntegrity,
  downloadModel,
  getModel,
  getCachedModels,
  deleteCachedModel,
  clearModelCache,
  checkStorageQuota,
} from './modules/modelCache.js';

export {
  applyCLAHE,
  prepareWorkingImage,
  recommendModel,
  normalizeGray,
  normalizeRgbJoint99,
  type ImageBufferLike,
  type HardwareCapabilities,
} from './modules/imagePreprocess.js';

export {
  float32ToFloat16,
  float16ToFloat32,
  float32ArrayToFloat16Bits,
  float16BitsToFloat32Array,
  reflectIndex,
  tileStarts,
  makeBlendWindow,
  createInferenceSession,
  probeWebGpuCapabilities,
  hasWebGpuAdapter,
  WebGpuDeviceLostError,
  isWebGpuDeviceLostError,
  resolveWasmPaths,
  /** @deprecated Legacy whole-image pipeline; does not reproduce upstream ImageGrains. Use runUnetCellposeInference. */
  runUnetInference,
  /** @deprecated Legacy tiling; does not reproduce upstream ImageGrains. Use runCpsamCellposeInference. */
  runCpsamTiledInference,
  runUnetCellposeInference,
  runCpsamCellposeInference,
  assertPlausibleOutput,
  NumericInstabilityError,
  type UnetCellposeOptions,
  type CpsamCellposeOptions,
  type SessionCreateOptions,
  type WebGpuCapabilities,
  type InferenceSessionResult,
} from './modules/onnxInference.js';

export {
  DEFAULT_POSTPROCESS_OPTIONS,
  multigridJacobiHeat,
  evaluateGrainFlowQcV4,
  trySplitDumbbellV4,
  computeGrainMorphometrics,
  flowsToMasksBrowser,
  type FlowQcResult,
} from './modules/postprocessCore.js';

export {
  computeGrainMorphometricsForIds,
  computeAllGrainMorphometrics,
  applyCalibrationToGrains,
  splitGrainAtLine,
  mergeGrains,
  deleteGrain,
  addPolygonGrain,
  MaskEditHistory,
  MaskEditHistory as MaskHistory,
  ScaleCalibrator,
  type EditOptions,
  type MaskEditResult,
  type MaskEditEntry,
} from './modules/interactiveEditor.js';

export {
  filterBorderGrains,
  weightedPsdPercentiles,
  computePsdPercentiles,
  computeFolkWardStats,
  computeWentworthProportions,
  computeSedimentStats,
  exportGrainsCsv,
  exportSummaryJson,
  exportSummaryCsv,
  exportInstanceMaskPng,
  exportInstanceMaskPng as exportMaskPng,
  exportGeoJsonContours,
  exportGeoJsonContours as exportGeoJson,
  exportSvgContours,
  exportSvgContours as exportSvg,
} from './modules/sedimentStats.js';

export {
  ImageGrainsEngine,
  AnalysisSession,
  type InferenceSessionLike,
  type ImageGrainsEngineOptions,
} from './modules/pipelineController.js';

export {
  buildValidBedMask,
  filterGrainsByRoiAndExclusion,
  solveHomography,
  invert3x3,
  applyHomographyPoint,
  rectifyPerspective,
  rectificationCalibration,
  type ExclusionBrushStroke,
  type RoiExclusionConfig,
  type ValidBedMask,
  type ExclusionFilterResult,
  type HomographyInput,
  type RectifiedImageResult,
} from './modules/roiAndRectify.js';

export {
  computeCroftonPerimeterPx,
  computeConvexHull,
  computeFeretDiameters,
  computePolygonAreaAndPerimeter,
  computeExtendedMorphometrics,
  computeFabricRoseStats,
  computeWentworthHistogram,
  type CachedGrainGeometry,
  type GrainHullCache,
  type ExtendedGrainMorphometrics,
  type FabricRoseBin,
  type FabricRoseStats,
  type WentworthBin,
} from './modules/morphometricsExt.js';

export {
  SITE_BIBLIOGRAPHIC_CITATIONS,
  getStatisticalBasisLabel,
  mulberry32,
  validateSiteCalibration,
  analyzeSite,
  exportSiteSummaryJson,
  exportSiteSummaryCsv,
  exportPooledGrainsCsv,
  buildSiteExportMetadata,
  withExclusionTolerance,
  exportSiteGrainsCsv,
  type PoolingMode,
  type SitePhotoMetadata,
  type SitePhotoInput,
  type SitePhotoEntry,
  type SiteAnalysisOptions,
  type SiteCalibrationValidation,
  type PsdConfidenceInterval,
  type FolkWardConfidenceInterval,
  type BinomialCiResult,
  type JackknifePhotoSensitivity,
  type JackknifeSensitivityReport,
  type ConvergencePoint,
  type SampleAdequacyRating,
  type SampleAdequacyReport,
  type PerPhotoSiteBreakdown,
  type SiteAnalysisReport,
} from './modules/siteAnalysis.js';

export {
  PROJECT_DB_NAME,
  PROJECT_DB_VERSION,
  SITE_STORE_NAME,
  PHOTO_STORE_NAME,
  RESULT_STORE_NAME,
  saveSite,
  getSite,
  listSites,
  deleteSite,
  savePhoto,
  getPhoto,
  listSitePhotos,
  deletePhoto,
  savePhotoResult,
  getPhotoResult,
  exportProjectArchive,
  exportSiteArchive,
  importProjectArchive,
  importSiteArchive,
  runSiteBatch,
  type ProjectStorageOptions,
  type SiteRecord,
  type PhotoRecord,
  type PhotoProcessStatus,
  type PhotoResultRecord,
  type ProjectArchiveV1,
  type BatchRunOptions,
  type BatchRunResult,
} from './modules/projectStorage.js';


export {
  APP_VERSION,
  ORT_VERSION,
  UNOFFICIAL_NOTICE,
  CITATION_NOTICE,
  SIZE_METRIC_DEFINITION,
  buildAnalysisProvenance,
  baseExportMetadata,
  csvCell,
} from './modules/provenance.js';

export {
  cpGetPadYX,
  cpTileStarts,
  cpTaperMask,
  cpResizeBilinear,
  cpPercentile1And99,
  cpNormalizeRgbPerChannel,
  runCellposeTiled,
  type CellposeVersion,
  type CellposeTilingOptions,
} from './modules/cellposeTiling.js';

// Site statistics helpers used by the app, so scripted use gives the same numbers.
export { weightedMidpointCdf, sizeAtCumulative, type WeightedCdf } from './modules/percentiles.js';
export { grainSizeIn } from './modules/grainSize.js';
export { photoDetectionLimitPx, grainStatsWeight, MAX_BOOTSTRAP_REPLICATES } from './modules/siteAnalysis.js';
export { siteCutoffReason, grainPoolWeight, MAX_WOLMAN_POINTS, type SiteCutoffReason } from './modules/sitePooling.js';
export { calibrateSiteInterval, MIN_PHOTOS_FOR_RELIABLE_CI, type SiteCiStatus } from './modules/siteUncertainty.js';
export { maxRatingForPhotos } from './modules/siteAdequacy.js';
export { DEFAULT_SITE_OPTIONS, SITE_OPTION_LIMITS, sanitizeSiteOptions, clampRecordTime } from './modules/siteOptions.js';
export { analysisSettingsOf, withinSiteSettingDifferences, siteReportProvenance, type SiteReportProvenance } from './modules/siteProvenance.js';
export { buildSiteInputs, computeWorkspaceReports, photoCutoffs, type WorkspaceReports } from './modules/siteWorkspace.js';

// Comparing sites and surveys over time.
export {
  computeComparedSites,
  comparePercentile,
  compareD50,
  surveyChanges,
  comparisonCsv,
  comparisonWarnings,
  settingsMismatches,
  holmAdjust,
  loadStoredSiteInputs,
  MIN_PHOTOS_FOR_TEST,
  type SiteForComparison,
  type ComparedSite,
  type D50Comparison,
  type SurveyChange,
  type ComparedPercentile,
  type ComparisonBasis,
} from './modules/siteComparison.js';

// Exports, results bundle, GIS and file decoding.
export { buildExport, isExportKind, EXPORT_KINDS, type ExportKind, type ExportContext, type ExportFile } from './modules/exports.js';
export { buildResultsBundle, resultsBundleEntries, type ResultsBundleInput } from './modules/resultsBundle.js';
export { photoGeoreference, geoJsonToMap, worldFile } from './modules/georef.js';
export { decodeTiffBuffer, isTiffFile, isSupportedImageFile } from './modules/tiffDecode.js';
export { planScaleCopy, suggestScaleTargets, scaleSourceOf, type ScaleCopyPlan, type ScaleSource } from './modules/scaleCopy.js';
export { revertedCalibrationAndRoi, scaleCalibrationAndRoi, photoUpscaleFactor } from './modules/imageEnhance.js';
