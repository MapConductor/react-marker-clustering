module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath:
          'import com.mapconductor.react.markerclustering.MapConductorMarkerClusteringPackage;',
        packageInstance: 'new MapConductorMarkerClusteringPackage()',
      },
    },
  },
};
