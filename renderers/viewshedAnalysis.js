
function ViewshedAnlysis(options) {
  options = options || {};
  //类
  this.Point = options.Point;
  this.Polyline = options.Polyline;
  this.Polygon = options.Polygon;
  this.geometryEngine = options.geometryEngine;
  this.Graphic = options.Graphic;
  this.GraphicsLayer = options.GraphicsLayer;
  this.externalRenderers = options.externalRenderers;
  this.webMercatorUtils = options.webMercatorUtils;
  this.glMatrix = options.glMatrix;
  //参数
  this.view = options.view || null;
  this.layers = options.layers;
  this.startPoint = options.startPoint || null;
  this.endPoint = options.endPoint || null;
  this.visibleColor = options.visibleColor || 'rgb(255,0,0)';
  this.inVisibleColor = options.inVisibleColor || 'rgb(0,153,51)';
  this.dataType = options.dataType || 'integrate';

  this.intersectPointLayer = new this.GraphicsLayer({ title: 'intersectPoint' });
  this.view.map.add(this.intersectPointLayer);
}
ViewshedAnlysis.prototype.setup = function (context) {
  this.renderer = new THREE.WebGLRenderer({
    context: context.gl,
    premultipliedAlpha: false,
    antialias: true,
    logarithmicDepthBuffer: true,
    polygonOffset: true,
    //polygonoffset 是一个比较常见的消除 z-fighting 的设置项。
    // 在 threejs 中我们可以设置 material 的 polygonoffset 属性来达到启用的目的。
    // 其原理是在渲染的时候，将模型的订单稍微向靠近或远离相机的方向做一定的偏移，从而错开两个靠近的面的目的。
    alpha: true
  });
  this.renderer.shadowMap.enabled = true;
  this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  //设置设备像素比，可以避免HiDPI设备上绘图模糊
  this.renderer.setPixelRatio(window.devicePixelRatio);
  //设置视口大小和三维场景的大小一样
  this.renderer.setViewport(0, 0, view.width, view.height);
  // 防止Three.js清除ArcGIS JS API提供的缓冲区
  this.renderer.autoClearDepth = false; // 定义renderer是否清除深度缓存
  this.renderer.autoClearStencil = false; // 定义renderer是否清除模板缓存
  this.renderer.autoClearColor = false; // 定义renderer是否清除颜色缓存
  //ArcGIS JS API渲染自定义离屏缓冲区，而不是默认的帧缓冲区。
  //我们必须将这段代码注入到Three.js运行时中，以便绑定这些缓冲区而不是默认的缓冲区。
  var originalSetRenderTarget = this.renderer.setRenderTarget.bind(this.renderer);
  this.renderer.setRenderTarget = function (target) {
    originalSetRenderTarget(target);
    this.state.viewport(new THREE.Vector4(0, 0, view.width, view.height));
    if (target == null) {
      context.bindRenderTarget();
    }
  }.bind(this.renderer);

  //支持裁切
  this.renderer.localClippingEnabled = true;

  this.scene = new THREE.Scene();
  this.camera = new THREE.PerspectiveCamera();
  this.camera.far = 10000000;
  this.ambient = new THREE.AmbientLight(0xffffff, 1);
  this.scene.add(this.ambient);
  //this.sun = new THREE.DirectionalLight(0xffffff, 0.5);
  //this.scene.add(this.sun);
  if (this.renderer.capabilities.isWebGL2 === false && this.renderer.extensions.has('WEBGL_depth_texture') === false) {
    supportsExtension = false;
  }
  let startP = [];
  let targetP = [];
  this.externalRenderers.toRenderCoordinates(view, this.startPoint, 0, this.view.spatialReference, startP, 0, 1);
  this.externalRenderers.toRenderCoordinates(view, this.endPoint, 0, this.view.spatialReference, targetP, 0, 1);

  let startGeometry = new THREE.SphereGeometry(2, 32, 32);
  let targetGeometry = new THREE.SphereGeometry(2, 32, 32);
  let targetMaterial = new THREE.MeshPhongMaterial({ color: new THREE.Color('#01d8d2') });

  this.targetObj = new THREE.Mesh(targetGeometry, targetMaterial);
  this.startObj = new THREE.Mesh(startGeometry, targetMaterial);
  this.targetObj.position.set(targetP[0], targetP[1], targetP[2]);
  this.startObj.position.set(startP[0], startP[1], startP[2]);

  this.scene.add(this.startObj);
  this.scene.add(this.targetObj);

  this.depthTarget = null;
  this.depthScene = null;
  this.orthCamera = null;

  this.clock = new THREE.Clock();
  //初始化
  this.init(context);
  context.resetWebGLState();
}
ViewshedAnlysis.prototype.render = function (context) {
  var cam = context.camera;
  this.camera.position.set(cam.eye[0], cam.eye[1], cam.eye[2]);
  this.camera.up.set(cam.up[0], cam.up[1], cam.up[2]);
  this.camera.lookAt(new THREE.Vector3(cam.center[0], cam.center[1], cam.center[2]));
  // 投影矩阵可以直接复制
  this.camera.projectionMatrix.fromArray(cam.projectionMatrix);

  if (this.materialShader && this.materialShader.uniforms) {
    this.materialShader.uniforms.tDepth.value = this.depthTarget.texture;
  }
  // 绘制场景
  this.renderer.state.reset();
  this.renderer.state.setBlending(THREE.NoBlending);
  this.renderer.render(this.scene, this.camera);
  // 请求重绘视图。
  this.externalRenderers.requestRender(view);
  context.resetWebGLState();
}
//初始化
ViewshedAnlysis.prototype.init = function (context) {
  //构建扇形立体几何
  this.nAngle = this.caculateAngle(this.startPoint, this.endPoint);
  this.distance_se = this.caculateDistance(this.startPoint, this.endPoint);
  this.baseArcRings = null;
  this.getArcGeometry(this.nAngle, this.distance_se);

  this.clipPanels = [];
  this.clipGeomerty(context);
}
//获取图层当前显示的坐标
ViewshedAnlysis.prototype.getCurrentPositions = function () {
  let that = this;
  let group = new THREE.Group();
  this.layers.forEach(function (layer) {
    let nodeDatas = layer.nodes;
    let visIncides = layer.visIncides;
    nodeDatas.forEach(function (item) {
      if (visIncides.indexOf(item.node.index) > -1) {
        var renderResult = item.data.transformedGeometry.interleavedVertexData;
        var layout = item.data.transformedGeometry.layout;
        var indices = item.data.transformedGeometry.indices;
        var indexes = item.index;
        var v1 = new Float32Array(renderResult);
        var v2 = new Uint8Array(renderResult);
        var v3 = new Uint16Array(renderResult);
        var colors = [];
        var uv0s = [];
        var positions = [];
        let float32_num = indexes[0] / 4;
        let start_p = indexes[1];
        let start_u = indexes[2];
        let start_c = indexes[4];
        var num = v1.length - (float32_num - 1);
        for (var i = 0; i < v1.length / float32_num; i++) {
          let rgba = v2.subarray(start_c * (i + 1), start_c * (i + 1) + 4);
          colors.push(rgba[0], rgba[1], rgba[2], rgba[3]);
        }
        for (var j = 0; j < num; j = j + float32_num) {
          let pos = v1.subarray(j + start_p, j + 3 + start_p);
          let renderPos = new Array(3);
          that.glMatrix.vec3.transformMat4(renderPos, [pos[0], pos[1], pos[2]], item.data.globalTrafo);
          positions.push(renderPos[0], renderPos[1], renderPos[2]);
          if (start_u != 0) {
            let uv = v1.subarray(j + start_u / 4, j + start_u / 4 + 2);
            uv0s.push(uv[0], uv[1]);
          }
        }
        var geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        start_u != 0 && geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv0s), 2));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(colors), 4));
        geometry.index = new THREE.BufferAttribute(indices, 1);
        geometry.computeVertexNormals();
        geometry.computeFaceNormals();
        var material = new THREE.MeshPhongMaterial({
          transparent: true,
          opacity: 0.6,
          vertexColors: THREE.VertexColors
        });
        var mesh = new THREE.Mesh(geometry, material);
        group.add(mesh);
      }
    });
  });
  //that.scene.add(group);
  return group;
}
//裁剪Geomerty
ViewshedAnlysis.prototype.clipGeomerty = function (context) {
  //构建裁切平面，裁切几何
  let startP = [];
  let endP = [];
  let baseM_Hp = [];
  let baseMPoint = [];
  this.externalRenderers.toRenderCoordinates(view, this.startPoint, 0, this.view.spatialReference, startP, 0, 1);
  this.externalRenderers.toRenderCoordinates(view, this.endPoint, 0, this.view.spatialReference, endP, 0, 1);
  this.externalRenderers.toRenderCoordinates(view, [this.baseArcRings[parseInt(this.baseArcRings.length / 2)][0], this.baseArcRings[parseInt(this.baseArcRings.length / 2)][1], this.baseArcRings[parseInt(this.baseArcRings.length / 2)][2] + 100], 0, this.view.spatialReference, baseM_Hp, 0, 1);
  this.externalRenderers.toRenderCoordinates(view, [this.baseArcRings[parseInt(this.baseArcRings.length / 2)][0], this.baseArcRings[parseInt(this.baseArcRings.length / 2)][1], this.baseArcRings[parseInt(this.baseArcRings.length / 2)][2]], 0, this.view.spatialReference, baseMPoint, 0, 1);
  let baseArcSp = [];
  let topArcSp = [];
  this.externalRenderers.toRenderCoordinates(view, this.baseArcRings[0], 0, this.view.spatialReference, baseArcSp, 0, 1);
  this.externalRenderers.toRenderCoordinates(view, [this.baseArcRings[0][0], this.baseArcRings[0][1], this.baseArcRings[0][2] + 100], 0, this.view.spatialReference, topArcSp, 0, 1);
  let baseArcEp = [];
  let topArcEp = [];
  this.externalRenderers.toRenderCoordinates(view, this.baseArcRings[this.baseArcRings.length - 2], 0, this.view.spatialReference, baseArcEp, 0, 1);
  this.externalRenderers.toRenderCoordinates(view, [this.baseArcRings[this.baseArcRings.length - 2][0], this.baseArcRings[this.baseArcRings.length - 2][1], this.baseArcRings[this.baseArcRings.length - 2][2] + 100], 0, this.view.spatialReference, topArcEp, 0, 1);
  let circleGeometry = new THREE.SphereGeometry(20, 32, 32);
  let targetMaterial = new THREE.MeshPhongMaterial({ color: new THREE.Color('red') });
  //创建切面
  let plane1 = new THREE.Plane();
  let p1_1 = new THREE.Vector3(startP[0], startP[1], startP[2]);
  let p2_1 = new THREE.Vector3(baseArcSp[0], baseArcSp[1], baseArcSp[2]);
  let p3_1 = new THREE.Vector3(topArcSp[0], topArcSp[1], topArcSp[2]);
  plane1.setFromCoplanarPoints(p1_1, p2_1, p3_1);
  let plane2 = new THREE.Plane();
  let p1_2 = new THREE.Vector3(startP[0], startP[1], startP[2]);
  let p2_2 = new THREE.Vector3(baseArcEp[0], baseArcEp[1], baseArcEp[2]);
  let p3_2 = new THREE.Vector3(topArcEp[0], topArcEp[1], topArcEp[2]);
  plane2.setFromCoplanarPoints(p1_2, p3_2, p2_2);
  //
  let plane3 = new THREE.Plane();
  let p1_3 = new THREE.Vector3(baseM_Hp[0], baseM_Hp[1], baseM_Hp[2]);
  let p2_3 = new THREE.Vector3(baseMPoint[0], baseMPoint[1], baseMPoint[2]);
  let p3_3 = new THREE.Vector3(baseArcEp[0], baseArcEp[1], baseArcEp[2]);
  plane3.setFromCoplanarPoints(p1_3, p2_3, p3_3);
  let plane4 = new THREE.Plane();
  let p1_4 = new THREE.Vector3(baseArcSp[0], baseArcSp[1], baseArcSp[2]);
  let p2_4 = new THREE.Vector3(baseMPoint[0], baseMPoint[1], baseMPoint[2]);
  let p3_4 = new THREE.Vector3(baseM_Hp[0], baseM_Hp[1], baseM_Hp[2]);
  plane4.setFromCoplanarPoints(p1_4, p2_4, p3_4);

  this.clipPanels.push(plane1);
  this.clipPanels.push(plane2);
  this.clipPanels.push(plane3);
  this.clipPanels.push(plane4);

  //构建相机，默认fov:40 ,平面夹角60
  let radius = this.distance_se;
  let width = radius * Math.tan(30 * Math.PI / 180);
  let height = radius * Math.tan(20 * Math.PI / 180);
  let radio = width / height;
  let camera_per = new THREE.PerspectiveCamera(40, radio, 1, parseInt(radius));
  camera_per.position.set(startP[0], startP[1], startP[2]);
  this.scene.add(camera_per);
  let upVec = p3_1.clone().sub(p2_1).normalize()
  camera_per.up.set(upVec.x, upVec.y, upVec.z);
  camera_per.lookAt(endP[0], endP[1], (endP[2]));

  var frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera_per.projectionMatrix, camera_per.matrixWorldInverse));

  let p_s = new THREE.Vector3(startP[0], startP[1], startP[2]);
  let p_e = new THREE.Vector3(endP[0], endP[1], endP[2]);
  let lightVec = p_e.clone().sub(p_s).normalize();

  let that = this;
  let meshMaterial = new THREE.MeshLambertMaterial({
    transparent: true,
    color: 'red',
    opacity: 0.8,
    clippingPlanes: this.clipPanels,
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -0.5
  });
  let geoGroup = this.getCurrentPositions();

  //计算阴影贴图材质
  this.materialShader = this.caculateShadowMap(camera_per);
  this.materialShader.clippingPlanes = this.clipPanels;
  geoGroup.children.forEach(function (mesh) {
    mesh.material = that.materialShader;
  });
  this.scene.add(geoGroup);
  this.createDepth(camera_per, geoGroup);
}
//创建深度图
ViewshedAnlysis.prototype.createDepth = function (_camera, mesh) {
  this.depthTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight);
  this.depthTarget.texture.format = THREE.RGBFormat;
  this.depthTarget.texture.minFilter = THREE.NearestFilter;
  this.depthTarget.texture.magFilter = THREE.NearestFilter;
  this.depthTarget.texture.generateMipmaps = false;
  this.depthTarget.depthBuffer = true;
  this.depthTarget.depthTexture = new THREE.DepthTexture();
  this.depthTarget.depthTexture.format = THREE.DepthFormat;
  this.depthTarget.depthTexture.type = THREE.UnsignedShortType;
  this.perCamera = _camera;

  const helper = new THREE.CameraHelper(this.perCamera);
  this.scene.add(helper);

  this.depthScene = new THREE.Scene();
  let ver = ` 
  precision highp float;
  uniform float cameraNear;
  uniform float cameraFar;
  varying float depth;
  varying vec4 vPosition;
  void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      depth = gl_Position.z / (cameraFar-cameraNear);
      vPosition=modelViewMatrix * vec4(position, 1.0);
  }
  `;
  let fra = `
  precision highp float;
  varying float depth;
  void main() {
      float hex = abs(depth) * 16777215.0; // 0xffffff
      float r = floor(hex / 65535.0);
      float g = floor((hex - r * 65535.0) / 255.0);
      float b = floor(hex - r * 65535.0 - g * 255.0);
      float a = sign(depth) >= 0.0 ? 1.0 : 0.0; // depth大于等于0，为1.0；小于0，为0.0。
      gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, a);
  }   
  `;

  let materialShader = new THREE.ShaderMaterial({
    vertexShader: ver,
    fragmentShader: fra,
    uniforms: {
      cameraNear: { value: _camera.near },
      cameraFar: { value: _camera.far },
      uLightLocation: {
        value: new THREE.Vector3(_camera.position.x, _camera.position.y, _camera.position.z)
      },
    }
  });
  this.depthScene.overrideMaterial = materialShader;
  //let mesh = new THREE.Mesh(meshGeo, materialShader);
  this.renderer.setRenderTarget(this.depthTarget);
  this.depthScene.children = [this.perCamera, mesh];
  this.renderer.clear();
  this.renderer.render(this.depthScene, this.perCamera);
  this.renderer.setRenderTarget(null);
}
//阴影贴图
ViewshedAnlysis.prototype.caculateShadowMap = function (camera) {
  let that = this;
  let texture = new THREE.TextureLoader().load('../images/view.png');// 
  let material = new THREE.MeshBasicMaterial({ map: texture, opacity: 0.7, side: THREE.FrontSide, color: new THREE.Color(this.inVisibleColor), transparent: true });
  material.onBeforeCompile = function (shader, renderer) {
    //声明用到的变量和常量
    const getFoot = `
        uniform mat4 cameraMatrix;
        uniform mat4 projectionMatrixInverse;
        varying float depth;
        varying vec2 depthUv;
        //varying vec2 vUv;
        varying vec4 vPosition;
        varying vec3 vPositionNormal;
        varying mat4 uMVPMatrixGY;
        #include <common>
        `;
    //此处获取到绘制顶点的世界坐标，并生成当前的深度图的uv
    const begin_vertex = `
        #include <worldpos_vertex>
        vPosition= modelMatrix * vec4(transformed, 1.0 );
        vPositionNormal = normalize(( modelViewMatrix * vec4(position, 1.0) ).xyz);
        uMVPMatrixGY= cameraMatrix * modelMatrix;
        vPositionNormal=normal;
        `;
    const depth_vary = `
        uniform float time;
        uniform sampler2D tDepth;
        uniform float opacity;
        uniform vec3 uLightLocation;
        uniform mat4 projectionMatrixInverse;
        uniform float cameraNear;
        uniform float cameraFar;
        uniform vec3 visColor; 
        uniform float dataType; 
        varying float depth;
        varying vec2 depthUv;
        varying vec4 vPosition;
        varying vec3 vPositionNormal;
        varying mat4 uMVPMatrixGY;
        `;

    const depth_frag = `
        float angle=acos(dot(normalize(vPositionNormal), normalize(vPosition.xyz-uLightLocation)))*57.29578;
        if(angle<=100.0){
          gl_FragColor = vec4( outgoingLight, diffuseColor.a );
        }else{
          vec4 gytyPosition=uMVPMatrixGY * vec4(vPosition.xyz,1);
          gytyPosition=gytyPosition/gytyPosition.w;  	
          float s=(gytyPosition.s+1.0)/2.0; 
          float t=(gytyPosition.t+1.0)/2.0; 
          vec2 uv_depth=vec2(s,t);
          vec4 depth4=texture2D(tDepth, uv_depth); 	//对投影纹理(距离纹理)图进行采样
          float hex = (depth4.r *255.0* 65535.0 + depth4.g * 255.0* 255.0 + depth4.b* 255.0) / 16777215.0;  
          float cameraDepth = hex * cameraFar; // 相机坐标系中点的深度
          vec4 H = vec4(s*2.0-1.0, t*2.0-1.0, hex, 1.0);
          vec4 D =projectionMatrixInverse*H;
          vec4 wordPos= D/D.w;
          float minDis=distance(wordPos.xyz,uLightLocation);
          float currDis=distance(vPosition.xyz,uLightLocation);	//计算光源到此片元的距离ZB
          float h=30.0;
          if(dataType==1.0){
            h=300.0;
          }
          //将采样出的颜色值换算成最小距离值ZA
          //float minZA=depth4.r*256.0*256.0+depth4.g*256.0+depth4.b+depth4.a/32.0;
          if(s>=0.0&&s<=1.0&&t>=0.0&&t<=1.0) {
              if(cameraDepth<currDis-h){//被遮挡
                gl_FragColor = vec4( outgoingLight, diffuseColor.a );
              }else{
                gl_FragColor= vec4(visColor.rgb,diffuseColor.a);
              }
          } else{ 	//不在阴影中
              gl_FragColor = vec4( outgoingLight, diffuseColor.a );
          }
        }
        `
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      getFoot
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <worldpos_vertex>",
      begin_vertex
    );
    shader.fragmentShader = shader.fragmentShader.replace('uniform float opacity;', depth_vary)
    shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', depth_frag)
    shader.uniforms.cameraMatrix = {
      value: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    }
    shader.uniforms.projectionMatrixInverse = {
      value: camera.projectionMatrixInverse
    }
    shader.uniforms.tDepth = {
      value: null
    }
    shader.uniforms.uLightLocation = {
      value: new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z)
    }
    shader.uniforms.cameraNear = {
      value: camera.near,
    }
    shader.uniforms.cameraFar = {
      value: camera.far,
    }
    shader.uniforms.visColor = {
      value: new THREE.Color(that.visibleColor)
    }
    shader.uniforms.dataType = {
      value: that.dataType === 'scene_jm' ? 1 : 0
    }
    material.uniforms = shader.uniforms;
  };
  return material;
}
//计算角度
ViewshedAnlysis.prototype.caculateAngle = function (pointS, pointE) {
  if (this.view.spatialReference.wkid === 4326 || this.view.spatialReference.wkid === 4490) {
    let anlng_a = pointS[0];
    let anlat_a = pointS[1];
    let anlng_b = pointE[0];
    let anlat_b = pointE[1];
    var d = 0;
    var lat_a = anlat_a * Math.PI / 180;
    var lng_a = anlng_a * Math.PI / 180;
    var lat_b = anlat_b * Math.PI / 180;
    var lng_b = anlng_b * Math.PI / 180;

    d = Math.sin(lat_a) * Math.sin(lat_b) + Math.cos(lat_a) * Math.cos(lat_b) * Math.cos(lng_b - lng_a);
    d = Math.sqrt(1 - d * d);
    d = Math.cos(lat_b) * Math.sin(lng_b - lng_a) / d;
    d = Math.asin(d) * 180 / Math.PI;
    if (anlat_a > anlat_b) {
      d = 180 - d;
    }
    if (d < 0) {
      d = 360 + d;
    }
    return d;
  } else {
    let vec_se = new THREE.Vector3(pointE[0] - pointS[0], pointE[1] - pointS[1], 0).normalize();
    let vec_oz = new THREE.Vector3(0, 1, 0).normalize();
    let angle_arc = vec_oz.angleTo(vec_se);
    if (vec_se.x > 0) {
      return angle_arc / Math.PI * 180;
    } else {
      return 360 - angle_arc / Math.PI * 180;
    }
  }

}
//计算距离
ViewshedAnlysis.prototype.caculateDistance = function (pointS, pointE) {
  if (this.view.spatialReference.wkid === 4326 || this.view.spatialReference.wkid === 4490) {
    let long1 = pointS[0];
    let lat1 = pointS[1];
    let long2 = pointE[0];
    let lat2 = pointE[1];
    // 地球半径的平均值，
    const R = 6371393;
    lat1 = lat1 * Math.PI / 180.0;
    lat2 = lat2 * Math.PI / 180.0;
    let a = lat1 - lat2;
    let b = (long1 - long2) * Math.PI / 180.0;
    let sa2 = Math.sin(a / 2.0);
    let sb2 = Math.sin(b / 2.0);
    return 2 * R * Math.asin(Math.sqrt(sa2 * sa2 + Math.cos(lat1) * Math.cos(lat2) * sb2 * sb2));
  } else {
    return Math.sqrt(Math.pow(pointE[0] - pointS[0], 2) +
      Math.pow(pointE[1] - pointS[1], 2) +
      Math.pow(pointE[2] - pointS[2], 2));
  }
}
//获取扇形几何
ViewshedAnlysis.prototype.getArcGeometry = function (nAngle, R) {//默认夹角60
  console.log("半径：" + R);
  let radius = parseInt(R) + 10;
  //扇形底面rings---center, radius, startAngle, endAngle, pointNum, A, B
  var apointSxPolygon = this.getHarcPoints([this.startPoint[0], this.startPoint[1], this.startPoint[2]], radius, nAngle - 30, nAngle + 30, 50, 90, null);
  apointSxPolygon[apointSxPolygon.length] = [this.startPoint[0], this.startPoint[1], this.startPoint[2]];

  //扇形上侧弧线
  var apointArcHeight = this.getHarcPoints([this.startPoint[0], this.startPoint[1], this.startPoint[2]], radius, nAngle - 30, nAngle + 30, 1000, 70, null);
  //中间
  var apointArcHeight_M = this.getHarcPoints([this.startPoint[0], this.startPoint[1], this.startPoint[2]], radius, nAngle - 30, nAngle + 30, 1000, 80, null);
  //竖直弧线
  var heightArcStart = this.getHarcPoints([this.startPoint[0], this.startPoint[1], this.startPoint[2]], radius, -10, 20, 1000, null, 90 - (nAngle - 30));
  var heightArcCenter1 = this.getHarcPoints([this.startPoint[0], this.startPoint[1], this.startPoint[2]], radius, -10, 20, 1000, null, 75 - (nAngle - 30));
  var heightArcCenter2 = this.getHarcPoints([this.startPoint[0], this.startPoint[1], this.startPoint[2]], radius, -10, 20, 1000, null, 60 - (nAngle - 30));
  var heightArcCenter3 = this.getHarcPoints([this.startPoint[0], this.startPoint[1], this.startPoint[2]], radius, -10, 20, 1000, null, 45 - (nAngle - 30));
  var heightArcEnd = this.getHarcPoints([this.startPoint[0], this.startPoint[1], this.startPoint[2]], radius, -10, 20, 1000, null, 30 - (nAngle - 30));

  var apoint2 = new Array();
  for (var k = 0; k < apointSxPolygon.length; k++) {
    apoint2[k] = [apointSxPolygon[k][0], apointSxPolygon[k][1], this.startPoint[2]];
  }
  let lineSymbol = {
    type: "simple-line",
    color: [255, 153, 0],
    width: 1.2
  };
  //上侧弧线graphic
  var polylineArcH = {
    type: "polyline",
    spatialReference: this.view.spatialReference,
    paths: apointArcHeight
  };
  var polylineArcHGraphic = new this.Graphic({
    geometry: polylineArcH,
    symbol: lineSymbol
  });
  //中间弧线graphic
  var polylineArcH_M = {
    type: "polyline",
    spatialReference: this.view.spatialReference,
    paths: apointArcHeight_M
  };
  var polylineArcHGraphic_M = new this.Graphic({
    geometry: polylineArcH_M,
    symbol: lineSymbol
  });
  //起点连上侧弧线
  var polylineSH1 = {
    type: "polyline",
    spatialReference: this.view.spatialReference,
    paths: [
      [this.startPoint[0], this.startPoint[1], this.startPoint[2]],
      [apointArcHeight[0][0], apointArcHeight[0][1], apointArcHeight[0][2]]
    ]
  };

  var polylineGraphicSH1 = new this.Graphic({
    geometry: polylineSH1,
    symbol: lineSymbol
  });

  var polylineSH2 = {
    type: "polyline",
    spatialReference: this.view.spatialReference,
    paths: [
      [this.startPoint[0], this.startPoint[1], this.startPoint[2]],
      [apointArcHeight[apointArcHeight.length - 1][0], apointArcHeight[apointArcHeight.length - 1][1], apointArcHeight[apointArcHeight.length - 1][2]]
    ]
  };
  var polylineGraphicSH2 = new this.Graphic({
    geometry: polylineSH2,
    symbol: lineSymbol
  });
  //上下弧线连接线
  var polylineUD1 = {
    type: "polyline",
    spatialReference: this.view.spatialReference,
    paths: heightArcStart
  };
  var polylineGraphicUD1 = new this.Graphic({
    geometry: polylineUD1,
    symbol: lineSymbol
  });
  var polylineUD2 = {
    type: "polyline",
    spatialReference: this.view.spatialReference,
    paths: heightArcEnd
  };
  var polylineGraphicUD2 = new this.Graphic({
    geometry: polylineUD2,
    symbol: lineSymbol
  });

  var polylineUD3 = {
    type: "polyline",
    spatialReference: this.view.spatialReference,
    paths: heightArcCenter1
  };
  var polylineGraphicUD3 = new this.Graphic({
    geometry: polylineUD3,
    symbol: lineSymbol
  });
  var polylineUD4 = {
    type: "polyline",
    spatialReference: this.view.spatialReference,
    paths: heightArcCenter2
  };
  var polylineGraphicUD4 = new this.Graphic({
    geometry: polylineUD4,
    symbol: lineSymbol
  });
  var polylineUD5 = {
    type: "polyline",
    spatialReference: this.view.spatialReference,
    paths: heightArcCenter3
  };
  var polylineGraphicUD5 = new this.Graphic({
    geometry: polylineUD5,
    symbol: lineSymbol
  });

  let inVisRgb = this.inVisibleColor.split('(')[1].split(')')[0].split(',');
  //扇形面
  var polygonArc = new this.Polygon({
    hasZ: false,
    hasM: false,
    rings: apoint2,
    spatialReference: this.view.spatialReference
  });
  var grArc = new this.Graphic({
    geometry: polygonArc,
    symbol: {
      type: "simple-fill",
      color: [inVisRgb[0], inVisRgb[1], inVisRgb[2], 0.5],
      outline: {
        color: [255, 153, 0],
        width: 1.2
      }
    }
  });
  this.view.graphics.add(grArc);
  //this.view.graphics.add(polylineArcHGraphic);
  //this.view.graphics.add(polylineArcHGraphic_M);
  //this.view.graphics.add(polylineGraphicSH1);
  //this.view.graphics.add(polylineGraphicSH2);
  // this.view.graphics.add(polylineGraphicUD1);
  // this.view.graphics.add(polylineGraphicUD2);
  // this.view.graphics.add(polylineGraphicUD3);
  // this.view.graphics.add(polylineGraphicUD4);
  // this.view.graphics.add(polylineGraphicUD5);
  this.arcGeometry = polygonArc;
  this.baseArcRings = apoint2;
}
//获弧线点
ViewshedAnlysis.prototype.getHarcPoints = function (center, radius, startAngle, endAngle, pointNum, A, B) {
  //A为与Z轴夹角，B为与X轴夹角
  var sinA;
  var cosA;
  var sinB;
  var cosB;
  var x;
  var y;
  var z;
  var angle;
  var points = new Array();
  if (this.view.spatialReference.wkid === 4326 || this.view.spatialReference.wkid === 4490) {

  }
  if (A != null && B == null) {//获取横向弧线（带高程）
    sinA = Math.sin(A * Math.PI / 180);
    cosA = Math.cos(A * Math.PI / 180);
    var centerZ = (this.view.spatialReference.wkid === 4326 || this.view.spatialReference.wkid === 4490) ? this.webMercatorUtils.lngLatToXY(center[0], center[1]) : [center[0], center[1]];
    for (var i = 0; i < pointNum; i++) {
      angle = startAngle + (endAngle - startAngle) * i / pointNum;
      cosB = Math.sin(angle * Math.PI / 180);
      sinB = Math.cos(angle * Math.PI / 180);
      x = centerZ[0] + radius * sinA * cosB;
      y = centerZ[1] + radius * sinA * sinB;
      z = center[2] + radius * cosA;
      var centerline = this.webMercatorUtils.xyToLngLat(x, y);
      points[i] = (this.view.spatialReference.wkid === 4326 || this.view.spatialReference.wkid === 4490) ? [centerline[0], centerline[1], z] : [x, y, z];
    }
    var point = points;
    return point;
  } else if (A == null && B != null) {//获取竖向弧线点
    sinB = Math.sin(B * Math.PI / 180);
    cosB = Math.cos(B * Math.PI / 180);
    var centerZ = (this.view.spatialReference.wkid === 4326 || this.view.spatialReference.wkid === 4490) ? this.webMercatorUtils.lngLatToXY(center[0], center[1]) : [center[0], center[1]];
    for (var i = 0; i < pointNum; i++) {
      angle = startAngle + (endAngle - startAngle) * i / pointNum;
      cosA = Math.sin(angle * Math.PI / 180);
      sinA = Math.cos(angle * Math.PI / 180);
      x = centerZ[0] + radius * sinA * cosB;
      y = centerZ[1] + radius * sinA * sinB;
      z = center[2] + radius * cosA;
      var centerline = this.webMercatorUtils.xyToLngLat(x, y);
      points[i] = (this.view.spatialReference.wkid === 4326 || this.view.spatialReference.wkid === 4490) ? [centerline[0], centerline[1], z] : [x, y, z];
    }
    var point = points;
    return point;
  }
}
ViewshedAnlysis.prototype.dispose = function (content) {
  this.view.graphics.removeAll();
  this.view.map.remove(this.intersectPointLayer);
}

